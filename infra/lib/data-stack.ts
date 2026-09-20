import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

// This AWS account isn't yet verified for CloudFront ("Your account must
// be verified before you can add new CloudFront resources... contact AWS
// Support" — a 403 on CreateDistribution, same class of account-history
// restriction as the CodeBuild quota denial earlier in this project).
// Flip to true once that's resolved; nothing else needs to change. Until
// then, dashboard/ is reachable the way it was before this was written:
// a presigned GET URL (`aws s3 presign s3://.../dashboard/index.html`),
// not a public link.
const ENABLE_CLOUDFRONT = false;

export class DataStack extends cdk.Stack {
  public readonly appRepository: ecr.Repository;
  public readonly k6Repository: ecr.Repository;
  public readonly runsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.appRepository = new ecr.Repository(this, 'AppRepository', {
      repositoryName: 'klyro-app',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Holds the k6 + run-and-upload.sh image (k6/Dockerfile). Unlike
    // klyro-app, this image doesn't change per-run, so it's built and
    // pushed manually / by hand rather than through build-stack's
    // per-runId CodeBuild pipeline.
    this.k6Repository = new ecr.Repository(this, 'K6Repository', {
      repositoryName: 'klyro-k6',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    this.runsBucket = new s3.Bucket(this, 'RunsBucket', {
      bucketName: `klyro-runs-${this.account}`,
      versioned: false,
      // Public access stays blocked at the ACL level; the bucket policy
      // below carves out exactly one key pattern (runs/*/report.json) for
      // anonymous reads, which requires blockPublicPolicy/restrictPublicBuckets
      // to be off. Nothing else in the bucket (source zips, per-run
      // findings/patches/metrics, the dashboard html itself) is reachable
      // without credentials.
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      // Lets a browser fetch() read the report.json response body
      // cross-origin (e.g. dashboard/index.html opened as a local file, or
      // from a presigned URL on this same bucket, which is already a
      // same-origin request but this also covers other hosts later).
      // Read access itself is still gated by the bucket policy below, not
      // by this rule.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: 'expire-run-artifacts',
          enabled: true,
          expiration: cdk.Duration.days(14),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // dashboard/index.html (a static, buildless page) reads exactly this
    // one path pattern directly from S3 — see dashboard/index.html and
    // CLAUDE.md's Storage section. Scoped with a resource-path wildcard
    // rather than a blanket public-read policy so every other object
    // (source zips, findings, patches, raw metrics) stays private.
    this.runsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'PublicReadReportJsonOnly',
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [this.runsBucket.arnForObjects('runs/*/report.json')],
      })
    );

    // dashboard/dist (the built Vite app — run `npm run build` in
    // dashboard/ before deploying, or this uploads a stale build)
    // uploaded to this same bucket under dashboard/ (no dedicated bucket
    // — fewer new resources). Public access is via CloudFront below when
    // enabled; otherwise this stays private, same as before CloudFront
    // was written (see ENABLE_CLOUDFRONT above).
    new s3deploy.BucketDeployment(this, 'DashboardDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'dashboard', 'dist'))],
      destinationBucket: this.runsBucket,
      destinationKeyPrefix: 'dashboard',
      // Short, not "none": CloudFront caches at the edge regardless of
      // what's set here (see the distribution's cache policy below), and
      // there's no invalidation step wired into a deploy, so a short S3
      // + CloudFront TTL is what makes a redeploy actually show up
      // without a manual `aws cloudfront create-invalidation`.
      cacheControl: [s3deploy.CacheControl.maxAge(cdk.Duration.minutes(1))],
      // This account's Lambda MemorySize quota caps out at 512MB (same
      // account-history restriction that denied the CodeBuild quota
      // increase) — the construct's own default of 1024MB gets rejected,
      // so it has to be pinned below the cap explicitly.
      memoryLimit: 512,
      prune: true,
    });

    if (ENABLE_CLOUDFRONT) {
      // CloudFront in front of dashboard/ via Origin Access Control
      // (OAC) — the modern replacement for the legacy OAI pattern.
      // originPath scopes every request this distribution ever makes to
      // the dashboard/ prefix; a viewer can't reach runs/* through it (no
      // path in the distribution's URL space maps there). Note the L2
      // withOriginAccessControl() helper's auto-generated bucket-policy
      // statement is technically scoped to s3:GetObject on the whole
      // bucket (conditioned on requests coming from this exact
      // distribution's ARN, not on key prefix) — CDK doesn't expose a
      // narrower option here. Practically unreachable outside dashboard/
      // because of originPath, but worth being explicit that the IAM
      // grant itself is broader than the HTTP-reachable surface.
      const dashboardOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.runsBucket, {
        originPath: '/dashboard',
      });
      const shortCachePolicy = new cloudfront.CachePolicy(this, 'DashboardCachePolicy', {
        cachePolicyName: 'klyro-dashboard-short-ttl',
        defaultTtl: cdk.Duration.minutes(1),
        minTtl: cdk.Duration.seconds(0),
        maxTtl: cdk.Duration.minutes(5),
      });
      const distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
        comment: 'klyro-dashboard',
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: dashboardOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: shortCachePolicy,
        },
      });
      new cdk.CfnOutput(this, 'DashboardUrl', { value: `https://${distribution.distributionDomainName}` });
    }
  }
}
