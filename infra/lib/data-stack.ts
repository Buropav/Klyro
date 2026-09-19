import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

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
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
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
  }
}
