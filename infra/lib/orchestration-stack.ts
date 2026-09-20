import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2i from 'aws-cdk-lib/aws-apigatewayv2-integrations';
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
  /** The EC2 instance ID of the SSM-driven app-image builder (replaces CodeBuild — see CLAUDE.md). */
  builderInstanceId: string;
}

// Each of analyst/investigator reads its own SSM SecureString parameter
// holding a JSON array of { apiKey, baseUrl, model } pool entries — see
// lambdas/llm-provider/index.js's LLMProvider for the rotation logic.
// This pool now deliberately spans TWO providers (Mistral and Groq, two
// keys each): Mistral's account-level rate limit made every request fail
// outright, and Groq was the original CLAUDE.md spec anyway, so rather
// than pick one, both are in the pool and LLMProvider rotates across all
// four on a 429 — a live, deliberate exception to "never silently switch
// providers mid-run," since these are pre-configured options, not an
// improvised fallback. Analyst gets each provider's smaller/faster model,
// Investigator gets each provider's larger/more-capable one, matching the
// original single-provider defaults' intent.
const LLM_KEY_POOL_ANALYST_PARAM = '/klyro/llm-key-pool-analyst';
const LLM_KEY_POOL_INVESTIGATOR_PARAM = '/klyro/llm-key-pool-investigator';

// Must match CLAUDE.md's Investigator allowlist exactly.
const ALLOWLISTED_FILES = ['demo-app/src/orders.js', 'demo-app/src/logger.js', 'demo-app/config/logger.json'];

const APP_TARGET_URL = 'http://app.klyro.internal:3000';
const APP_CONTAINER_NAME = 'app';

export class OrchestrationStack extends cdk.Stack {
  public readonly triggerFunction: lambda.Function;
  public readonly statusFunction: lambda.Function;
  public readonly listRunsFunction: lambda.Function;
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
      builderInstanceId,
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
        // CloudWatch, SSM, ECS's control plane, and the LLM providers'
        // public APIs, none of which needs VPC access. Staying out of the
        // VPC avoids a NAT gateway, same reasoning CLAUDE.md gives for the
        // LLM calls.
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

    // The state machine's physical name is fixed, so both its ARN and its
    // executions' ARN pattern are derivable before the CfnStateMachine
    // itself exists — which report-writer (created earlier, below) needs,
    // since it cannot reference this.stateMachine.attrArn yet. Declared
    // once here so the name can never drift between the resource and the
    // IAM statements that scope to it.
    const stateMachineName = 'klyro-experiment';
    const stateMachineArn = `arn:aws:states:${this.region}:${this.account}:stateMachine:${stateMachineName}`;
    const executionArnPattern = `arn:aws:states:${this.region}:${this.account}:execution:${stateMachineName}:*`;

    const grantLlmKeyPoolAccess = (fn: lambda.Function, paramName: string) => {
      const paramArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${paramName}`;
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [paramArn] }));
      // kms:Decrypt for the SecureString above. This CANNOT be scoped to
      // the alias ARN (arn:aws:kms:...:alias/aws/ssm): IAM evaluates
      // kms:Decrypt against the resolved KEY ARN (.../key/<key-id>), so a
      // statement naming the alias never matches and GetParameter with
      // WithDecryption:true fails with AccessDenied at runtime. The
      // AWS-managed key's id isn't knowable at synth time without a
      // lookup, so the documented pattern is Resource:* narrowed by a
      // kms:ViaService condition — which restricts this to decryption
      // performed *by SSM on this function's behalf*, nothing else.
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: ['*'],
          conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
        })
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
      { LLM_KEY_POOL_PARAM: LLM_KEY_POOL_ANALYST_PARAM },
      { timeoutSeconds: 90 }
    );
    grantGet(this.analystFunction, 'runs/*/*/summary.json');
    grantPutJson(this.analystFunction, 'runs/*/*/finding.json');
    grantLlmKeyPoolAccess(this.analystFunction, LLM_KEY_POOL_ANALYST_PARAM);

    // --- investigator ---------------------------------------------------
    this.investigatorFunction = makeFunction(
      'InvestigatorFunction',
      'investigator',
      { LLM_KEY_POOL_PARAM: LLM_KEY_POOL_INVESTIGATOR_PARAM },
      { timeoutSeconds: 90 }
    );
    grantGet(this.investigatorFunction, 'runs/*/*/finding.json');
    grantGet(this.investigatorFunction, 'runs/*/*/summary.json');
    grantPutJson(this.investigatorFunction, 'runs/*/*/patch.json');
    grantLlmKeyPoolAccess(this.investigatorFunction, LLM_KEY_POOL_INVESTIGATOR_PARAM);

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
      // Used to derive this run's execution ARN for the per-stage timeline
      // baked into report.json. Best-effort inside the handler — see the
      // note on readTimeline() — so an unset value degrades to a null
      // timeline rather than failing the report.
      { STATE_MACHINE_ARN: stateMachineArn },
      { memoryMB: 128, timeoutSeconds: 30 }
    );
    // Same deterministic-ARN reasoning as statusFunction below: scoped to
    // this state machine's own executions, never states:ListExecutions.
    this.reportWriterFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:DescribeExecution', 'states:GetExecutionHistory'],
        resources: [executionArnPattern],
      })
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

    // Build step: ssm:SendCommand against the one builder instance, running
    // the fixed AWS-RunShellScript document — see CLAUDE.md for why this
    // replaced CodeBuild StartBuild.sync. SendCommand needs permission on
    // both the target instance and the document; GetCommandInvocation (used
    // by the hand-built poll loop, since SSM has no .sync integration) has
    // no resource-level permissions in SSM's IAM action reference — an
    // AWS-required "*" exception, same category as ecs:DescribeServices below.
    const builderInstanceArn = `arn:aws:ec2:${this.region}:${this.account}:instance/${builderInstanceId}`;
    const runShellScriptDocArn = `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`;
    addStateMachinePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [builderInstanceArn, runShellScriptDocArn],
      })
    );
    addStateMachinePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation'], resources: ['*'] })
    );

    // ECS RunTask.sync for both db-init and k6 — needs the documented
    // EventBridge managed-rule permissions .sync integrations require,
    // plus PassRole for whichever task/execution roles those two task
    // definitions use.
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
      BuilderInstanceId: builderInstanceId,
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
      stateMachineName,
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

    // --- status (polls a run's Step Functions execution) ----------------
    this.statusFunction = makeFunction(
      'StatusFunction',
      'status',
      { STATE_MACHINE_ARN: this.stateMachine.attrArn },
      { memoryMB: 128, timeoutSeconds: 15 }
    );
    // Execution ARNs are derived deterministically inside status/index.js
    // (":stateMachine:" -> ":execution:" + runId, since trigger/ always
    // names executions after runId) rather than looked up, so this only
    // needs read access scoped to this one state machine's own
    // executions — not states:ListExecutions or anything broader.
    this.statusFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:DescribeExecution', 'states:GetExecutionHistory'],
        resources: [executionArnPattern],
      })
    );

    // --- list-runs (run history) -----------------------------------------
    this.listRunsFunction = makeFunction('ListRunsFunction', 'list-runs', {}, { memoryMB: 256, timeoutSeconds: 30 });
    grantGet(this.listRunsFunction, 'runs/*/report.json');
    // Same scoped-to-runs/ s3:ListBucket grant as reportWriterFunction
    // above — ListObjectsV2 is a bucket-level action, so it can't be
    // scoped via a resource ARN the way GetObject is; the s3:prefix
    // condition is what keeps this from being bucket-wide.
    this.listRunsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [runsBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': 'runs/*' } },
      })
    );

    // Public HTTP API in front of trigger/ and status/ so the dashboard
    // can POST /run and poll GET /status/{runId} directly from the
    // browser — both were invoke-only ("aws lambda invoke") until now.
    // No auth: this is a judge-facing demo, not a multi-tenant control
    // plane — trigger/ only ever starts a brand-new, self-contained run,
    // and status/ only ever reads that run's own already-public
    // execution progress (the same information report.json exposes once
    // the run finishes). CORS is origin '*': the brief asked for the
    // dashboard's CloudFront domain specifically, but no CloudFront
    // distribution exists in this project (the dashboard is a private S3
    // object opened via presigned URL — see CLAUDE.md's Dashboard
    // section) — so this uses the same open-CORS approach already in use
    // for /run rather than allowlisting a domain that doesn't exist yet.
    const httpApi = new apigwv2.HttpApi(this, 'TriggerHttpApi', {
      apiName: 'klyro-trigger-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type'],
      },
    });
    httpApi.addRoutes({
      path: '/run',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2i.HttpLambdaIntegration('TriggerIntegration', this.triggerFunction),
    });
    httpApi.addRoutes({
      path: '/status/{runId}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2i.HttpLambdaIntegration('StatusIntegration', this.statusFunction),
    });
    httpApi.addRoutes({
      path: '/runs',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2i.HttpLambdaIntegration('ListRunsIntegration', this.listRunsFunction),
    });

    new cdk.CfnOutput(this, 'TriggerFunctionName', { value: this.triggerFunction.functionName });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.attrArn });
    new cdk.CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'TriggerApiUrl', { value: `${httpApi.apiEndpoint}/run` });
  }
}
