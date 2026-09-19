import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface OrchestrationStackProps extends cdk.StackProps {
  runsBucket: s3.IBucket;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  appService: ecs.FargateService;
  appTaskDefinition: ecs.FargateTaskDefinition;
  appRepository: ecr.IRepository;
  dbInitTaskDefinition: ecs.FargateTaskDefinition;
  dbInitSecurityGroup: ec2.ISecurityGroup;
  k6TaskDefinition: ecs.FargateTaskDefinition;
  k6SecurityGroup: ec2.ISecurityGroup;
  appBuildProject: codebuild.IProject;
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

const APP_TARGET_URL = 'http://app.klyro.internal:3000';
const APP_CONTAINER_NAME = 'app';

export class OrchestrationStack extends cdk.Stack {
  public readonly triggerFunction: lambda.Function;
  public readonly metricsCompactorFunction: lambda.Function;
  public readonly analystFunction: lambda.Function;
  public readonly investigatorFunction: lambda.Function;
  public readonly guardFunction: lambda.Function;
  public readonly deployAppFunction: lambda.Function;
  public readonly evaluatorFunction: lambda.Function;
  public readonly reportWriterFunction: lambda.Function;
  public readonly stateMachine: sfn.CfnStateMachine;

  constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);

    const {
      runsBucket,
      vpc,
      cluster,
      appService,
      appTaskDefinition,
      appRepository,
      dbInitTaskDefinition,
      dbInitSecurityGroup,
      k6TaskDefinition,
      k6SecurityGroup,
      appBuildProject,
    } = props;
    const repoRoot = path.join(__dirname, '..', '..');
    const lambdasRoot = path.join(repoRoot, 'lambdas');

    // investigator/ and guard/ both need the CURRENT content of the three
    // allowlisted demo-app files. Per an earlier prompt, that content is
    // small enough to inline directly rather than fetched at runtime, so
    // it's embedded here at synth time (read from the repo) into a
    // manifest file zipped alongside the function code — regenerated
    // every synth, not checked into git (see .gitignore).
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
        // CloudWatch, SSM, ECS's control plane, and Mistral's public API,
        // none of which needs VPC access. Staying out of the VPC avoids a
        // NAT gateway, same reasoning CLAUDE.md gives for the LLM calls.
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
      CLUSTER_NAME: cluster.clusterName,
      APP_SERVICE_NAME: appService.serviceName,
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

    // --- deploy-app ---------------------------------------------------------
    this.deployAppFunction = makeFunction(
      'DeployAppFunction',
      'deploy-app',
      {
        CLUSTER_NAME: cluster.clusterName,
        APP_SERVICE_NAME: appService.serviceName,
        APP_TASK_FAMILY: appTaskDefinition.family,
        APP_REPOSITORY_URI: appRepository.repositoryUri,
        APP_CONTAINER_NAME,
      },
      { memoryMB: 128, timeoutSeconds: 60 }
    );
    // ecs:DescribeTaskDefinition and ecs:RegisterTaskDefinition have no
    // resource-level permissions in ECS's IAM action reference — both
    // AWS-required "*" exceptions (RegisterTaskDefinition creates a new
    // resource, so there's nothing to scope to; Describe is one of the
    // ECS Describe* actions that just isn't resource-scopable).
    this.deployAppFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition'],
        resources: ['*'],
      })
    );
    this.deployAppFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ecs:UpdateService'], resources: [appService.serviceArn] })
    );
    this.deployAppFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [appTaskDefinition.taskRole.roleArn, appTaskDefinition.executionRole!.roleArn],
        conditions: { StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      })
    );

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
    // report-writer's readJsonOptional() reads several of the above keys
    // that legitimately may not exist yet (this is the whole point of the
    // MarkFailed path — most of a run's artifacts are still missing when
    // it fails early). Without s3:ListBucket, S3 returns 403 AccessDenied
    // (mentioning ListBucket) instead of 404 NoSuchKey for a GetObject on
    // a missing key when the caller lacks list permission on the bucket,
    // which readJsonOptional's `err.name === 'NoSuchKey'` check doesn't
    // catch — so a normal "file doesn't exist yet" case was throwing and
    // taking down the MarkFailed safety net itself. Scoped to the runs/
    // prefix this function already reads/writes, not the whole bucket.
    this.reportWriterFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [runsBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': 'runs/*' } },
      })
    );

    // --- experiment state machine -------------------------------------
    const stateMachineRole = new iam.Role(this, 'ExperimentStateMachineRole', {
      roleName: 'klyro-experiment-state-machine-role',
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });

    // Collected into an explicit iam.Policy (below) instead of using
    // stateMachineRole.addToPolicy() directly: addToPolicy's statements
    // land on a separate AWS::IAM::Policy resource that only the Role
    // (not this policy) is wired into stateMachineRole.roleArn's CFN
    // dependency graph, so CloudFormation has no ordering guarantee that
    // the policy is attached before CreateStateMachine runs — which is
    // exactly what caused the "not authorized to create managed-rule"
    // AccessDenied on first deploy (CreateStateMachine validates managed
    // EventBridge rule permissions synchronously, unlike Lambda's lazy
    // invoke-time IAM checks). An explicit dependency on the Policy
    // resource itself fixes the ordering.
    const stateMachinePolicyStatements: iam.PolicyStatement[] = [];
    const addStateMachinePolicy = (statement: iam.PolicyStatement) => {
      stateMachinePolicyStatements.push(statement);
    };

    for (const fn of [
      this.metricsCompactorFunction,
      this.analystFunction,
      this.investigatorFunction,
      this.guardFunction,
      this.deployAppFunction,
      this.evaluatorFunction,
      this.reportWriterFunction,
    ]) {
      addStateMachinePolicy(
        new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [fn.functionArn] })
      );
    }

    // CodeBuild StartBuild.sync — the extra events:* grant is the documented
    // requirement for Step Functions' .sync integrations: they subscribe to
    // a managed EventBridge rule to know when the build finishes.
    addStateMachinePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds'],
        resources: [appBuildProject.projectArn],
      })
    );
    addStateMachinePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
        resources: [
          `arn:aws:events:${this.region}:${this.account}:rule/StepFunctionsGetEventForCodeBuildStartBuildRule`,
        ],
      })
    );

    // ECS RunTask.sync for both db-init and k6 — same documented .sync
    // EventBridge requirement as CodeBuild above, plus PassRole for
    // whichever task/execution roles those two task definitions use.
    const dbInitTaskDefArnPattern = `arn:aws:ecs:${this.region}:${this.account}:task-definition/${dbInitTaskDefinition.family}:*`;
    const k6TaskDefArnPattern = `arn:aws:ecs:${this.region}:${this.account}:task-definition/${k6TaskDefinition.family}:*`;
    addStateMachinePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [dbInitTaskDefArnPattern, k6TaskDefArnPattern],
      })
    );
    // ecs:StopTask/DescribeTasks have no resource-level permissions —
    // AWS-required "*" (the specific task ARN doesn't exist until RunTask
    // creates it, so it can't be pre-scoped).
    addStateMachinePolicy(
      new iam.PolicyStatement({ actions: ['ecs:StopTask', 'ecs:DescribeTasks'], resources: ['*'] })
    );
    addStateMachinePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [
          dbInitTaskDefinition.taskRole.roleArn,
          dbInitTaskDefinition.executionRole!.roleArn,
          k6TaskDefinition.taskRole.roleArn,
          k6TaskDefinition.executionRole!.roleArn,
        ],
        conditions: { StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      })
    );
    addStateMachinePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
        resources: [`arn:aws:events:${this.region}:${this.account}:rule/StepFunctionsGetEventsForECSTaskRule`],
      })
    );

    // Direct AWS SDK integration (ecs:describeServices) for the rollout
    // stabilization poll loop — DescribeServices has no resource-level
    // permissions either, AWS-required "*".
    addStateMachinePolicy(
      new iam.PolicyStatement({ actions: ['ecs:DescribeServices'], resources: ['*'] })
    );

    const publicSubnets = vpc.publicSubnets;
    if (publicSubnets.length < 2) {
      throw new Error('Expected at least 2 public subnets for the experiment state machine');
    }

    // Written as a standalone ASL file (statemachine/experiment.asl.json)
    // rather than built with CDK's Task/Chain constructs, per this
    // prompt's instruction — definitionSubstitutions fills in the
    // deploy-specific values (${Placeholder} tokens in the JSON) that
    // can't be known until this stack synthesizes.
    const stateMachineDefinition = fs.readFileSync(
      path.join(repoRoot, 'statemachine', 'experiment.asl.json'),
      'utf8'
    );
    const substitutions: Record<string, string> = {
      AppBuildProjectName: appBuildProject.projectName,
      ClusterName: cluster.clusterName,
      AppServiceName: appService.serviceName,
      DbInitTaskFamily: dbInitTaskDefinition.family,
      K6TaskFamily: k6TaskDefinition.family,
      PublicSubnet1: publicSubnets[0].subnetId,
      PublicSubnet2: publicSubnets[1].subnetId,
      DbInitSecurityGroupId: dbInitSecurityGroup.securityGroupId,
      K6SecurityGroupId: k6SecurityGroup.securityGroupId,
      AppTargetUrl: APP_TARGET_URL,
      DeployAppFunctionArn: this.deployAppFunction.functionArn,
      MetricsCompactorFunctionArn: this.metricsCompactorFunction.functionArn,
      AnalystFunctionArn: this.analystFunction.functionArn,
      InvestigatorFunctionArn: this.investigatorFunction.functionArn,
      GuardFunctionArn: this.guardFunction.functionArn,
      EvaluatorFunctionArn: this.evaluatorFunction.functionArn,
      ReportWriterFunctionArn: this.reportWriterFunction.functionArn,
    };
    let renderedDefinition = stateMachineDefinition;
    for (const [key, value] of Object.entries(substitutions)) {
      renderedDefinition = renderedDefinition.split(`\${${key}}`).join(value);
    }

    // Attached as one explicit iam.Policy resource (not via
    // stateMachineRole.addToPolicy per-statement) so the CfnStateMachine
    // below can take an explicit CFN dependency on it — see the comment
    // by addStateMachinePolicy's definition above.
    const stateMachinePolicy = new iam.Policy(this, 'ExperimentStateMachinePolicy', {
      statements: stateMachinePolicyStatements,
    });
    stateMachinePolicy.attachToRole(stateMachineRole);

    // Using the raw CfnStateMachine (rather than the sfn.StateMachine L2)
    // keeps this a literal deploy of the ASL file's own DefinitionString,
    // with no CDK-side reinterpretation of the state graph.
    this.stateMachine = new sfn.CfnStateMachine(this, 'ExperimentStateMachine', {
      stateMachineName: 'klyro-experiment',
      stateMachineType: 'STANDARD',
      roleArn: stateMachineRole.roleArn,
      definitionString: renderedDefinition,
    });
    // CreateStateMachine synchronously validates that the role can create
    // the managed EventBridge rules its .sync integrations need — unlike
    // Lambda's lazy invoke-time IAM checks. roleArn alone only orders this
    // after the Role resource, not the separately-attached Policy, so
    // without this the policy could still be mid-attach (or not even
    // started) when CreateStateMachine runs, producing exactly the
    // "not authorized to create managed-rule" AccessDenied seen on the
    // first deploy attempt.
    this.stateMachine.node.addDependency(stateMachinePolicy);

    // --- trigger (created last: needs the state machine's ARN) ----------
    this.triggerFunction = makeFunction(
      'TriggerFunction',
      'trigger',
      { STATE_MACHINE_ARN: this.stateMachine.attrArn },
      { memoryMB: 128, timeoutSeconds: 15 }
    );
    this.triggerFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [this.stateMachine.attrArn] })
    );

    new cdk.CfnOutput(this, 'TriggerFunctionName', { value: this.triggerFunction.functionName });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.attrArn });
  }
}
