import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface BuildStackProps extends cdk.StackProps {
  appRepository: ecr.IRepository;
  runsBucket: s3.IBucket;
}

// Placeholder source key the project is defined against at synth time. Each
// real build overrides this via StartBuild's sourceLocationOverride, pointing
// at that run's zipped repo snapshot (demo-app/, possibly LLM-patched)
// uploaded to s3://<runsBucket>/runs/<runId>/source.zip.
const PLACEHOLDER_SOURCE_KEY = 'source/bootstrap-placeholder.zip';

export class BuildStack extends cdk.Stack {
  public readonly appBuildProject: codebuild.Project;

  constructor(scope: Construct, id: string, props: BuildStackProps) {
    super(scope, id, props);

    const { appRepository, runsBucket } = props;

    const buildSpec = codebuild.BuildSpec.fromObject({
      version: '0.2',
      env: {
        variables: {
          // Overridden per-invocation by the orchestration Step Functions
          // (environmentVariablesOverride on StartBuild) with the real
          // runId and phase (baseline|optimized). These defaults only
          // matter for a manual/ad-hoc build.
          RUN_ID: 'local',
          PHASE: 'baseline',
        },
      },
      phases: {
        pre_build: {
          commands: [
            'echo Logging in to ECR...',
            'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$ECR_REPOSITORY_URI"',
            // Image tag is runId-phase, not CodeBuild's default
            // CODEBUILD_RESOLVED_SOURCE_VERSION-based git tagging — every
            // artifact in this pipeline is keyed by runId instead.
            'IMAGE_TAG="${RUN_ID}-${PHASE}"',
            'echo "Resolved image tag: $IMAGE_TAG (source version was $CODEBUILD_RESOLVED_SOURCE_VERSION)"',
          ],
        },
        build: {
          commands: [
            'echo Building demo-app image...',
            'docker build -t "$ECR_REPOSITORY_URI:$IMAGE_TAG" -f demo-app/Dockerfile demo-app',
          ],
        },
        post_build: {
          commands: [
            'echo Pushing "$ECR_REPOSITORY_URI:$IMAGE_TAG"...',
            'docker push "$ECR_REPOSITORY_URI:$IMAGE_TAG"',
          ],
        },
      },
    });

    this.appBuildProject = new codebuild.Project(this, 'AppBuildProject', {
      projectName: 'klyro-app-build',
      description: 'Builds demo-app/Dockerfile and pushes runId-phase tagged images to ECR',
      source: codebuild.Source.s3({
        bucket: runsBucket,
        path: PLACEHOLDER_SOURCE_KEY,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
      },
      environmentVariables: {
        ECR_REPOSITORY_URI: { value: appRepository.repositoryUri },
        RUN_ID: { value: 'local' },
        PHASE: { value: 'baseline' },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER, codebuild.LocalCacheMode.CUSTOM),
      buildSpec,
      timeout: cdk.Duration.minutes(20),
      // No custom `logging.cloudWatch.logGroup` here: CDK's CodeBuild L2
      // always scopes the role's logs:* grant to the conventional
      // /aws/codebuild/<projectName> group regardless of what log group
      // the logging config points at, so supplying a differently-named
      // group would leave the role unable to write to it. Letting
      // CodeBuild use its default log group keeps the grant and the
      // actual destination in sync.
    });

    // Least-privilege ECR access scoped to exactly this one repository.
    // grantPullPush also adds ecr:GetAuthorizationToken on resource "*",
    // which is the one AWS-required exception (that action has no
    // resource-level scoping).
    appRepository.grantPullPush(this.appBuildProject);

    // codebuild.Source.s3() above already grants read on the placeholder
    // key alone. Real runs override the source per-build (StartBuild's
    // sourceLocationOverride) with a runId-specific zip under the same
    // "source/" prefix, so the build role needs read on the whole prefix,
    // not just the one placeholder object — mirrors the runs/<runId>/*
    // scoping CLAUDE.md specifies for the k6 task role.
    runsBucket.grantRead(this.appBuildProject, 'source/*');

    new cdk.CfnOutput(this, 'AppBuildProjectName', { value: this.appBuildProject.projectName });
  }
}
