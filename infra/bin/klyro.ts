#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { BuildStack } from '../lib/build-stack';

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
  appImageTag: app.node.tryGetContext('appImageTag') ?? 'bootstrap',
});
compute.addStackDependency(network);
compute.addStackDependency(data);

const build = new BuildStack(app, 'Klyro-BuildStack', {
  env,
  appRepository: data.appRepository,
  runsBucket: data.runsBucket,
});
build.addStackDependency(data);
