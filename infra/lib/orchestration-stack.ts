import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface OrchestrationStackProps extends cdk.StackProps {
  runsBucket: s3.IBucket;
  clusterName: string;
  appServiceName: string;
  /**
   * Not wired up yet — the Step Functions state machine
   * (statemachine/experiment.asl.json) that trigger/ starts is a later
   * prompt's deliverable. Until it's supplied, trigger's STATE_MACHINE_ARN
   * env var is left unset and the function fails fast if invoked.
   */
  stateMachineArn?: string;
}

// Mistral, not Groq — CLAUDE.md originally specified Groq, but the user
// already had a Mistral key in hand and Mistral's free-tier rate limits
// suit this project's repeated-testing usage better; Mistral's API is
// OpenAI-compatible so MistralProvider only differs from a Groq client in
// base URL and model IDs (see lambdas/llm-provider/index.js).
const MISTRAL_API_KEY_PARAM = '/klyro/mistral-api-key';
const LLM_MODEL_ANALYST_DEFAULT = 'mistral-small-latest';
const LLM_MODEL_INVESTIGATOR_DEFAULT = 'mistral-large-latest';

// Must match CLAUDE.md's Investigator allowlist exactly.
const ALLOWLISTED_FILES = ['demo-app/src/orders.js', 'demo-app/src/logger.js', 'demo-app/config/logger.json'];

export class OrchestrationStack extends cdk.Stack {
  public readonly triggerFunction: lambda.Function;
  public readonly metricsCompactorFunction: lambda.Function;
  public readonly analystFunction: lambda.Function;
  public readonly investigatorFunction: lambda.Function;
  public readonly guardFunction: lambda.Function;
  public readonly evaluatorFunction: lambda.Function;
  public readonly reportWriterFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    const { runsBucket, clusterName, appServiceName } = props;
    const repoRoot = path.join(__dirname, '..', '..');
    const lambdasRoot = path.join(repoRoot, 'lambdas');

    // investigator/ and guard/ both need the CURRENT content of the three
    // allowlisted demo-app files. Per this prompt, that content is small
    // enough to inline directly rather than fetched at runtime, so it's
    // embedded here at synth time (read from the repo) into a manifest
    // file zipped alongside the function code — regenerated every synth,
    // not checked into git (see .gitignore).
    const manifest: Record<string, string> = {};
    for (const relPath of ALLOWLISTED_FILES) {
      manifest[relPath] = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    }
    fs.writeFileSync(
      path.join(lambdasRoot, 'shared-allowlist-manifest.generated.json'),
      JSON.stringify(manifest)
    );

    // One shared code asset (the whole lambdas/ tree) for every function,
    // so each handler's relative requires (e.g. investigator's
    // `require('../llm-provider')`) resolve inside the zip without a
    // bundler or a Lambda Layer.
    const code = lambda.Code.fromAsset(lambdasRoot);

    const commonEnv: Record<string, string> = {
      RESULTS_BUCKET: runsBucket.bucketName,
    };

    const makeFunction = (
      name: string,
      handlerDir: string,
      extraEnv: Record<string, string> = {},
      options: { memoryMB?: number; timeoutSeconds?: number } = {}
    ): lambda.Function => {
      const logGroup = new logs.LogGroup(this, `${name}LogGroup`, {
        logGroupName: `/klyro/lambda/${handlerDir}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      return new lambda.Function(this, name, {
        functionName: `klyro-${handlerDir}`,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: `${handlerDir}/index.handler`,
        code,
        memorySize: options.memoryMB ?? 256,
        timeout: cdk.Duration.seconds(options.timeoutSeconds ?? 60),
        environment: { ...commonEnv, ...extraEnv },
        logGroup,
        // No vpc/vpcSubnets on any of these — they only talk to S3,
        // CloudWatch, SSM, Step Functions, and Mistral's public API, none
        // of which needs VPC access. Staying out of the VPC avoids a NAT
        // gateway, same reasoning CLAUDE.md originally gave for the Groq
        // calls (now Mistral) it specified.
      });
    };

    // s3:GetObject / s3:PutObject scoped to an exact key pattern — not
    // bucket.grantRead()/grantPut(), which also grant
    // GetBucket*/List*/PutObjectLegalHold/Retention/Tagging/Abort* and
    // would be broader than any of these functions actually need.
    const grantGet = (fn: lambda.Function, keyPattern: string) =>
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [runsBucket.arnForObjects(keyPattern)] })
      );
    const grantPutJson = (fn: lambda.Function, keyPattern: string) =>
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [runsBucket.arnForObjects(keyPattern)] })
      );

    const mistralParamArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${MISTRAL_API_KEY_PARAM}`;
    const ssmDefaultKmsKeyArn = `arn:aws:kms:${this.region}:${this.account}:alias/aws/ssm`;
    const grantMistralAccess = (fn: lambda.Function) => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [mistralParamArn] })
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [ssmDefaultKmsKeyArn] })
      );
    };

    // --- metrics-compactor ------------------------------------------------
    this.metricsCompactorFunction = makeFunction('MetricsCompactorFunction', 'metrics-compactor', {
      CLUSTER_NAME: clusterName,
      APP_SERVICE_NAME: appServiceName,
      EMF_NAMESPACE: 'Klyro/DemoApp',
    });
    grantGet(this.metricsCompactorFunction, 'runs/*/*/results.json');
    grantPutJson(this.metricsCompactorFunction, 'runs/*/*/summary.json');
    // cloudwatch:GetMetricData has no resource-level permissions —
    // AWS-required "*", the one exception to "name resources explicitly".
    this.metricsCompactorFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['cloudwatch:GetMetricData'], resources: ['*'] })
    );

    // --- analyst ------------------------------------------------------------
    this.analystFunction = makeFunction(
      'AnalystFunction',
      'analyst',
      {
        MISTRAL_API_KEY_PARAM,
        LLM_MODEL_ANALYST: process.env.LLM_MODEL_ANALYST || LLM_MODEL_ANALYST_DEFAULT,
      },
      { timeoutSeconds: 90 }
    );
    grantGet(this.analystFunction, 'runs/*/*/summary.json');
    grantPutJson(this.analystFunction, 'runs/*/*/finding.json');
    grantMistralAccess(this.analystFunction);

    // --- investigator ---------------------------------------------------
    this.investigatorFunction = makeFunction(
      'InvestigatorFunction',
      'investigator',
      {
        MISTRAL_API_KEY_PARAM,
        LLM_MODEL_INVESTIGATOR: process.env.LLM_MODEL_INVESTIGATOR || LLM_MODEL_INVESTIGATOR_DEFAULT,
      },
      { timeoutSeconds: 90 }
    );
    grantGet(this.investigatorFunction, 'runs/*/*/finding.json');
    grantGet(this.investigatorFunction, 'runs/*/*/summary.json');
    grantPutJson(this.investigatorFunction, 'runs/*/*/patch.json');
    grantMistralAccess(this.investigatorFunction);

    // --- guard ------------------------------------------------------------
    this.guardFunction = makeFunction('GuardFunction', 'guard', {}, { memoryMB: 128, timeoutSeconds: 30 });
    grantGet(this.guardFunction, 'runs/*/*/patch.json');
    grantPutJson(this.guardFunction, 'runs/*/*/patch.verified.json');

    // --- evaluator ----------------------------------------------------------
    this.evaluatorFunction = makeFunction('EvaluatorFunction', 'evaluator', {}, { memoryMB: 128, timeoutSeconds: 30 });
    grantGet(this.evaluatorFunction, 'runs/*/*/summary.json');
    grantPutJson(this.evaluatorFunction, 'runs/*/evaluation.json');

    // --- report-writer ----------------------------------------------------
    this.reportWriterFunction = makeFunction(
      'ReportWriterFunction',
      'report-writer',
      {},
      { memoryMB: 128, timeoutSeconds: 30 }
    );
    grantGet(this.reportWriterFunction, 'runs/*/*/finding.json');
    grantGet(this.reportWriterFunction, 'runs/*/*/patch.verified.json');
    grantGet(this.reportWriterFunction, 'runs/*/*/summary.json');
    grantGet(this.reportWriterFunction, 'runs/*/evaluation.json');
    grantPutJson(this.reportWriterFunction, 'runs/*/report.json');

    // --- trigger ------------------------------------------------------------
    this.triggerFunction = makeFunction(
      'TriggerFunction',
      'trigger',
      props.stateMachineArn ? { STATE_MACHINE_ARN: props.stateMachineArn } : {},
      { memoryMB: 128, timeoutSeconds: 15 }
    );
    // Scoped by naming convention to the not-yet-existing state machine
    // rather than granted after the fact, so wiring in stateMachineArn
    // later doesn't require an IAM change too.
    this.triggerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [`arn:aws:states:${this.region}:${this.account}:stateMachine:klyro-*`],
      })
    );

    new cdk.CfnOutput(this, 'TriggerFunctionName', { value: this.triggerFunction.functionName });
  }
}
