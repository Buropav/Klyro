import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  appRepository: ecr.IRepository;
  k6Repository: ecr.IRepository;
  runsBucket: s3.IBucket;
  /**
   * Image tag the "app" service's task definition is seeded with at
   * `cdk deploy` time. Runtime baseline/optimized runs register their own
   * task definition revisions (runId-baseline / runId-optimized) directly
   * via the ECS API from the orchestration pipeline, not through CDK.
   */
  appImageTag?: string;
  /** Image tag for the k6 task definition. This image doesn't change per-run. */
  k6ImageTag?: string;
}

const DB_NAME = 'klyro';
const DB_USER = 'klyro';
const DB_PORT = 5432;
const APP_PORT = 3000;
const CLOUD_MAP_NAMESPACE = 'klyro.internal';

export class ComputeStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly appService: ecs.FargateService;
  public readonly appTaskDefinition: ecs.FargateTaskDefinition;
  public readonly dbService: ecs.FargateService;
  public readonly dbInitTaskDefinition: ecs.FargateTaskDefinition;
  public readonly k6TaskDefinition: ecs.FargateTaskDefinition;
  public readonly appSecurityGroup: ec2.SecurityGroup;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly dbInitSecurityGroup: ec2.SecurityGroup;
  public readonly k6SecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { vpc, appRepository, k6Repository, runsBucket } = props;
    const appImageTag = props.appImageTag ?? 'bootstrap';
    const k6ImageTag = props.k6ImageTag ?? 'latest';

    this.cluster = new ecs.Cluster(this, 'KlyroCluster', {
      clusterName: 'klyro-cluster',
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const namespace = this.cluster.addDefaultCloudMapNamespace({
      name: CLOUD_MAP_NAMESPACE,
    });

    // One shared credential for the throwaway Postgres instance — it holds
    // only synthetic seed data behind a security group that admits nothing
    // but the app and db-init tasks, so a single generated secret is enough.
    const dbCredentials = new secretsmanager.Secret(this, 'DbCredentials', {
      secretName: 'klyro/db-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: DB_USER }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 24,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Security groups -----------------------------------------------
    this.appSecurityGroup = new ec2.SecurityGroup(this, 'AppServiceSecurityGroup', {
      securityGroupName: 'klyro-app-service-sg',
      vpc,
      description: 'Klyro app Fargate service',
      allowAllOutbound: true,
    });

    this.dbInitSecurityGroup = new ec2.SecurityGroup(this, 'DbInitSecurityGroup', {
      securityGroupName: 'klyro-db-init-sg',
      vpc,
      description: 'Klyro db-init one-off task',
      allowAllOutbound: true,
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbServiceSecurityGroup', {
      securityGroupName: 'klyro-db-service-sg',
      vpc,
      description: 'Klyro postgres db Fargate service',
      allowAllOutbound: true,
    });
    this.dbSecurityGroup.addIngressRule(
      this.appSecurityGroup,
      ec2.Port.tcp(DB_PORT),
      'Allow the app service to reach Postgres'
    );
    this.dbSecurityGroup.addIngressRule(
      this.dbInitSecurityGroup,
      ec2.Port.tcp(DB_PORT),
      'Allow the db-init task to reach Postgres'
    );

    this.k6SecurityGroup = new ec2.SecurityGroup(this, 'K6SecurityGroup', {
      securityGroupName: 'klyro-k6-sg',
      vpc,
      description: 'Klyro k6 load-test task',
      allowAllOutbound: true,
    });
    this.appSecurityGroup.addIngressRule(
      this.k6SecurityGroup,
      ec2.Port.tcp(APP_PORT),
      'Allow the k6 task to reach the app service'
    );

    // --- db: long-lived Fargate service ---------------------------------
    const dbLogGroup = new logs.LogGroup(this, 'DbLogGroup', {
      logGroupName: '/klyro/ecs/db',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dbTaskDefinition = new ecs.FargateTaskDefinition(this, 'DbTaskDefinition', {
      family: 'klyro-db',
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    dbTaskDefinition.addContainer('postgres', {
      containerName: 'postgres',
      image: ecs.ContainerImage.fromRegistry('postgres:16'),
      portMappings: [{ containerPort: DB_PORT }],
      environment: {
        POSTGRES_DB: DB_NAME,
        POSTGRES_USER: DB_USER,
      },
      secrets: {
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentials, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: dbLogGroup, streamPrefix: 'db' }),
      // Container filesystem is ephemeral Fargate storage — fine, since
      // db-init drops and reseeds the schema on every run.
    });

    this.dbService = new ecs.FargateService(this, 'DbService', {
      serviceName: 'klyro-db',
      cluster: this.cluster,
      taskDefinition: dbTaskDefinition,
      desiredCount: 1,
      assignPublicIp: true, // public-subnet-only VPC, no NAT — needed to pull postgres:16 from Docker Hub
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [this.dbSecurityGroup],
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: 'db',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });
    const dbHost = `db.${CLOUD_MAP_NAMESPACE}`;

    // --- app: Fargate service running the Klyro demo app ----------------
    const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: '/klyro/ecs/app',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CPU/memory are fixed constants here on purpose — the non-negotiable
    // invariant is that infra stays identical between baseline and
    // optimized runs; only the image tag changes, and that happens via
    // out-of-band ECS RegisterTaskDefinition/UpdateService calls from the
    // orchestration pipeline, not by redeploying this stack.
    this.appTaskDefinition = new ecs.FargateTaskDefinition(this, 'AppTaskDefinition', {
      family: 'klyro-app',
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    this.appTaskDefinition.addContainer('app', {
      containerName: 'app',
      image: ecs.ContainerImage.fromEcrRepository(appRepository, appImageTag),
      portMappings: [{ containerPort: APP_PORT }],
      environment: {
        PORT: String(APP_PORT),
        PGHOST: dbHost,
        PGPORT: String(DB_PORT),
        PGDATABASE: DB_NAME,
        PGUSER: DB_USER,
      },
      secrets: {
        PGPASSWORD: ecs.Secret.fromSecretsManager(dbCredentials, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: appLogGroup, streamPrefix: 'app' }),
    });

    this.appService = new ecs.FargateService(this, 'AppService', {
      serviceName: 'klyro-app',
      cluster: this.cluster,
      taskDefinition: this.appTaskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [this.appSecurityGroup],
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: 'app',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });
    this.appService.node.addDependency(this.dbService);

    // --- db-init: one-off task definition that resets + reseeds the db --
    const dbInitLogGroup = new logs.LogGroup(this, 'DbInitLogGroup', {
      logGroupName: '/klyro/ecs/db-init',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.dbInitTaskDefinition = new ecs.FargateTaskDefinition(this, 'DbInitTaskDefinition', {
      family: 'klyro-db-init',
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const seedSql = fs.readFileSync(
      path.join(__dirname, '..', '..', 'demo-app', 'db', 'seed.sql'),
      'utf8'
    );

    this.dbInitTaskDefinition.addContainer('db-init', {
      containerName: 'db-init',
      image: ecs.ContainerImage.fromRegistry('postgres:16'),
      essential: true,
      entryPoint: ['sh', '-c'],
      command: [
        [
          'set -eu',
          `psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'KLYRO_SEED_EOF'`,
          seedSql,
          'KLYRO_SEED_EOF',
        ].join('\n'),
      ],
      environment: {
        PGHOST: dbHost,
        PGPORT: String(DB_PORT),
        PGDATABASE: DB_NAME,
        PGUSER: DB_USER,
      },
      secrets: {
        PGPASSWORD: ecs.Secret.fromSecretsManager(dbCredentials, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: dbInitLogGroup, streamPrefix: 'db-init' }),
    });

    // --- k6: one-off task definition that load-tests app and uploads
    // results.json to S3 -------------------------------------------------
    const k6LogGroup = new logs.LogGroup(this, 'K6LogGroup', {
      logGroupName: '/klyro/ecs/k6',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.k6TaskDefinition = new ecs.FargateTaskDefinition(this, 'K6TaskDefinition', {
      family: 'klyro-k6',
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    this.k6TaskDefinition.addContainer('k6', {
      containerName: 'k6',
      image: ecs.ContainerImage.fromEcrRepository(k6Repository, k6ImageTag),
      essential: true,
      environment: {
        // Fixed, known at synth time.
        S3_BUCKET: runsBucket.bucketName,
        // RUN_ID, PHASE, and TARGET_URL are deliberately absent here —
        // run-and-upload.sh requires them and fails fast if they're
        // missing, so every invocation must supply them via RunTask
        // containerOverrides. Baking in defaults would let a caller
        // silently reuse a stale runId/phase/target.
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: k6LogGroup, streamPrefix: 'k6' }),
    });

    // Exactly s3:PutObject on runs/<anything>/<anything>/results.json —
    // not grantPut(), which also adds PutObjectLegalHold/Retention/Tagging
    // and Abort* and would be broader than what this task actually needs.
    this.k6TaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [runsBucket.arnForObjects('runs/*/*/results.json')],
      })
    );

    new cdk.CfnOutput(this, 'DbInitTaskDefinitionArn', {
      value: this.dbInitTaskDefinition.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, 'K6TaskDefinitionArn', {
      value: this.k6TaskDefinition.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
  }
}
