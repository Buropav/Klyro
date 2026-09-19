#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { BuildStack } from '../lib/build-stack';
import { OrchestrationStack } from '../lib/orchestration-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-south-1',
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
  appRepository: data.appRepository,
  runsBucket: data.runsBucket,
});
build.addStackDependency(data);

const orchestration = new OrchestrationStack(app, 'Klyro-OrchestrationStack', {
  env,
  runsBucket: data.runsBucket,
  clusterName: compute.cluster.clusterName,
  appServiceName: compute.appService.serviceName,
  stateMachineArn: app.node.tryGetContext('stateMachineArn'),
});
orchestration.addStackDependency(data);
orchestration.addStackDependency(compute);
