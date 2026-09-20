#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { BuildStack } from '../lib/build-stack';
import { OrchestrationStack } from '../lib/orchestration-stack';

const app = new cdk.App();

// CLAUDE.md pins this project to ap-south-1. Reading CDK_DEFAULT_REGION
// first did NOT honour that: the CDK CLI injects that variable into the
// app's environment from whatever region the caller's AWS profile resolves
// to (us-east-1 when none is configured), so the fallback could never be
// reached and a teammate with a differently-configured profile would
// silently deploy the whole stack to the wrong region. KLYRO_REGION is an
// explicit, project-owned override instead.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.KLYRO_REGION || 'ap-south-1',
};

const network = new NetworkStack(app, 'Klyro-NetworkStack', { env });
const data = new DataStack(app, 'Klyro-DataStack', { env });

const compute = new ComputeStack(app, 'Klyro-ComputeStack', {
  env,
  vpc: network.vpc,
  appRepository: data.appRepository,
  k6Repository: data.k6Repository,
  runsBucket: data.runsBucket,
  appImageTag: app.node.tryGetContext('appImageTag') ?? 'bootstrap',
  k6ImageTag: app.node.tryGetContext('k6ImageTag') ?? 'latest',
});
compute.addStackDependency(network);
compute.addStackDependency(data);

const build = new BuildStack(app, 'Klyro-BuildStack', {
  env,
  vpc: network.vpc,
  appRepository: data.appRepository,
  runsBucket: data.runsBucket,
});
build.addStackDependency(network);
build.addStackDependency(data);

const orchestration = new OrchestrationStack(app, 'Klyro-OrchestrationStack', {
  env,
  runsBucket: data.runsBucket,
  vpc: network.vpc,
  cluster: compute.cluster,
  appService: compute.appService,
  appTaskDefinition: compute.appTaskDefinition,
  appRepository: data.appRepository,
  dbInitTaskDefinition: compute.dbInitTaskDefinition,
  dbInitSecurityGroup: compute.dbInitSecurityGroup,
  k6TaskDefinition: compute.k6TaskDefinition,
  k6SecurityGroup: compute.k6SecurityGroup,
  builderInstanceId: build.builderInstance.instanceId,
});
orchestration.addStackDependency(network);
orchestration.addStackDependency(data);
orchestration.addStackDependency(compute);
orchestration.addStackDependency(build);
