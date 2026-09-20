import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface BuildStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  appRepository: ecr.IRepository;
  runsBucket: s3.IBucket;
}

// The one, permanent build source: a zip of demo-app/ (repo-root
// relative, so it unpacks to a "demo-app/" folder in the build
// workspace), uploaded once out-of-band (see infra/README or the deploy
// notes) — not per-run. Both baseline and optimized builds use this same
// zip; "optimized" builds patch one file in place during the build
// script instead of needing a second, per-run source archive.
const BASELINE_SOURCE_KEY = 'source/baseline.zip';

// Builds demo-app/Dockerfile and pushes runId-phase tagged images to ECR.
//
// This was originally a CodeBuild project (see git history / CLAUDE.md's
// note on the swap). CodeBuild's concurrent-build quota came back 0 in
// every region for this account, and AWS Support's quota-increase
// response asked for "at least one billing cycle" of general account
// usage before reconsidering — not a wait this project had time for. EC2
// on-demand vCPU quota was already non-zero, so this is a single,
// always-on Amazon Linux 2023 instance with Docker installed, driven by
// SSM RunCommand (AWS-RunShellScript) instead of CodeBuild's StartBuild.
// It runs the exact same steps a CodeBuild buildspec would: log in to
// ECR, fetch the static source zip, apply the guarded patch in place for
// an "optimized" build, `docker build`, `docker push`.
export class BuildStack extends cdk.Stack {
  public readonly builderInstance: ec2.Instance;

  constructor(scope: Construct, id: string, props: BuildStackProps) {
    super(scope, id, props);

    const { vpc, appRepository, runsBucket } = props;

    const builderRole = new iam.Role(this, 'BuilderInstanceRole', {
      roleName: 'klyro-builder-instance-role',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // Required for the SSM Agent to register this instance and
        // receive RunCommand documents — no finer-grained equivalent
        // exists for "let SSM manage this instance."
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Least-privilege ECR access scoped to exactly this one repository.
    // grantPullPush also adds ecr:GetAuthorizationToken on resource "*",
    // the one AWS-required exception (that action has no resource-level
    // scoping).
    appRepository.grantPullPush(builderRole);

    // s3:GetObject scoped to exactly the static source zip and the
    // guarded per-run patch — not bucket-wide read.
    builderRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [
          runsBucket.arnForObjects(BASELINE_SOURCE_KEY),
          runsBucket.arnForObjects('runs/*/baseline/patch.verified.json'),
        ],
      })
    );

    const securityGroup = new ec2.SecurityGroup(this, 'BuilderSecurityGroup', {
      securityGroupName: 'klyro-builder-sg',
      vpc,
      description: 'Klyro app-image builder (EC2 + SSM RunCommand, replaces CodeBuild)',
      allowAllOutbound: true, // needs ECR, Docker Hub (base images), and SSM endpoints
    });

    // Static, not per-run — the same script handles every runId/phase,
    // parameterized entirely via environment variables SSM RunCommand
    // sets on each invocation (see statemachine/experiment.asl.json).
    const buildScript = `#!/bin/bash
# pipefail matters here: the 'aws ecr get-login-password | docker login'
# pipeline below reports only docker login's exit code without it, so a
# failed credential fetch would look like a successful login and surface
# much later as an opaque 'no basic auth credentials' on docker push.
set -euo pipefail
: "\${RUN_ID:?RUN_ID is required}"
: "\${PHASE:?PHASE is required}"

ECR_REPOSITORY_URI="${appRepository.repositoryUri}"
RESULTS_BUCKET="${runsBucket.bucketName}"
REGION="${this.region}"

# docker login takes a REGISTRY host, not a repository URI. repositoryUri
# is "<acct>.dkr.ecr.<region>.amazonaws.com/klyro-app"; passing the path
# component too makes docker store the credential under the wrong key, and
# the later push fails with "no basic auth credentials". Strip to the host.
ECR_REGISTRY="\${ECR_REPOSITORY_URI%%/*}"

if [ ! -f /opt/klyro/.bootstrap-ok ]; then
  echo "Builder instance user-data did not complete (missing /opt/klyro/.bootstrap-ok)." >&2
  exit 1
fi

echo "Building runId=$RUN_ID phase=$PHASE"

# Reclaim space before each build: this is a long-lived instance and every
# run leaves two more tagged images plus build cache behind. On the default
# 8 GiB AL2023 root volume that fills after a handful of runs, and the only
# symptom is an SSM "Failed" with "no space left on device".
docker image prune -af --filter "until=24h" || true
docker builder prune -af --filter "until=24h" || true

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"

WORKDIR="/tmp/klyro-build-$RUN_ID-$PHASE"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

aws s3 cp "s3://$RESULTS_BUCKET/${BASELINE_SOURCE_KEY}" ./baseline.zip
unzip -q ./baseline.zip

if [ "$PHASE" = "optimized" ]; then
  echo "Applying guarded patch for $RUN_ID..."
  aws s3 cp "s3://$RESULTS_BUCKET/runs/$RUN_ID/baseline/patch.verified.json" ./patch.json
  # guard/ already enforces the allowlist upstream, but this is the one
  # place that actually writes to disk as root, so it re-checks rather than
  # trusting its input: the resolved target must stay inside the unpacked
  # source tree and must already exist.
  node -e "const fs=require('fs'),path=require('path');const p=JSON.parse(fs.readFileSync('./patch.json','utf8'));const root=path.resolve('demo-app');const t=path.resolve(p.file);if(t!==root&&!t.startsWith(root+path.sep))throw new Error('patch target escapes demo-app/: '+p.file);if(!fs.existsSync(t))throw new Error('patch target does not exist: '+p.file);fs.writeFileSync(t,p.full_new_content,'utf8');console.log('Patched',p.file);"
fi

IMAGE_TAG="$RUN_ID-$PHASE"
docker build -t "$ECR_REPOSITORY_URI:$IMAGE_TAG" -f demo-app/Dockerfile demo-app
docker push "$ECR_REPOSITORY_URI:$IMAGE_TAG"

cd /
rm -rf "$WORKDIR"
echo "Build complete: $ECR_REPOSITORY_URI:$IMAGE_TAG"
`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -eu',
      'dnf install -y docker unzip nodejs',
      'systemctl enable --now docker',
      'mkdir -p /opt/klyro',
      // Heredoc with a quoted delimiter ('BUILD_SCRIPT_EOF') so none of
      // the script's own $VAR references are expanded by user-data's
      // shell — they're meant to be evaluated when the script itself
      // runs, not when user-data writes it out.
      "cat > /opt/klyro/build.sh << 'BUILD_SCRIPT_EOF'",
      buildScript,
      'BUILD_SCRIPT_EOF',
      'chmod +x /opt/klyro/build.sh',
      // Marker file written only if everything above succeeded. Nothing
      // signals user-data failure back to CloudFormation, so without this
      // a failed bootstrap shows up as a green BuildStack and then a first
      // run that dies with 'No such file or directory'. build.sh checks it.
      'touch /opt/klyro/.bootstrap-ok'
    );

    this.builderInstance = new ec2.Instance(this, 'BuilderInstance', {
      instanceName: 'klyro-builder',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      role: builderRole,
      userData,
      // AL2023's default root volume is 8 GiB, which a Node image build
      // plus two retained tags per run exhausts quickly. 30 GiB is the
      // free-tier EBS ceiling, so this costs nothing extra and removes the
      // most common opaque build failure.
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
        },
      ],
      // IMDSv2-only: this box holds a role that can push to ECR and read
      // the runs bucket, and it sits in a public subnet.
      requireImdsv2: true,
      // Public IP, no NAT — same reasoning as every other component in
      // this VPC: pulling images (ECR + Docker Hub for node:20-alpine)
      // and reaching SSM's endpoints both need outbound internet, and
      // there's no NAT Gateway in this account's network stack.
    });

    new cdk.CfnOutput(this, 'BuilderInstanceId', { value: this.builderInstance.instanceId });
  }
}
