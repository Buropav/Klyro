import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface BuildStackProps extends cdk.StackProps {
  appRepository: ecr.IRepository;
  runsBucket: s3.IBucket;
}

// The one, permanent CodeBuild source: a zip of demo-app/ (repo-root
// relative, so it unpacks to a "demo-app/" folder in the build
// workspace), uploaded once out-of-band (see infra/README or the deploy
// notes) — not per-run. Both baseline and optimized builds use this same
// zip; "optimized" builds patch one file in place during pre_build
// instead of needing a second, per-run source archive.
const BASELINE_SOURCE_KEY = 'source/baseline.zip';

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
          // (EnvironmentVariablesOverride on StartBuild) with the real
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
            // For an "optimized" build, the source tree is still the
            // unmodified baseline — apply the guard-verified patch from
            // the baseline phase in place before building, rather than
            // needing a second, per-run source zip.
            'if [ "$PHASE" = "optimized" ]; then\n' +
              '  echo "Applying guarded patch for $RUN_ID...";\n' +
              '  aws s3 cp "s3://${RESULTS_BUCKET}/runs/${RUN_ID}/baseline/patch.verified.json" /tmp/patch.json;\n' +
              '  node -e "const fs=require(\'fs\');const p=JSON.parse(fs.readFileSync(\'/tmp/patch.json\',\'utf8\'));fs.writeFileSync(p.file,p.full_new_content,\'utf8\');console.log(\'Patched\',p.file);"\n' +
              'fi',
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
        path: BASELINE_SOURCE_KEY,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
      },
      environmentVariables: {
        ECR_REPOSITORY_URI: { value: appRepository.repositoryUri },
        RESULTS_BUCKET: { value: runsBucket.bucketName },
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

    // codebuild.Source.s3() above already grants read on exactly
    // BASELINE_SOURCE_KEY. "optimized" builds additionally need to read
    // the guarded patch produced by the baseline phase's guard/ Lambda.
    this.appBuildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [runsBucket.arnForObjects('runs/*/baseline/patch.verified.json')],
      })
    );

    new cdk.CfnOutput(this, 'AppBuildProjectName', { value: this.appBuildProject.projectName });
  }
}
