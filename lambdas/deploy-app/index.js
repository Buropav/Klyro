'use strict';

// Registers a new revision of the "app" task definition pointing at
// runId-phase's freshly built image, then updates the app service to use
// it. Step Functions has no native "UpdateService with a new image" SDK
// call — ecs:UpdateService only takes a task definition ARN, and building
// one means describing the current definition, swapping the image, and
// registering a new revision — a handful of dependent calls with real
// data-shaping in between, not something ASL's JSONPath ResultSelector
// can do without a Lambda.
const {
  ECSClient,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} = require('@aws-sdk/client-ecs');

const ecs = new ECSClient({});

const CLUSTER_NAME = process.env.CLUSTER_NAME;
const APP_SERVICE_NAME = process.env.APP_SERVICE_NAME;
const APP_TASK_FAMILY = process.env.APP_TASK_FAMILY;
const APP_REPOSITORY_URI = process.env.APP_REPOSITORY_URI;
const APP_CONTAINER_NAME = process.env.APP_CONTAINER_NAME || 'app';

exports.handler = async (event) => {
  const { runId, phase } = event || {};
  if (!runId || !phase) {
    throw new Error('runId and phase are required in the event payload');
  }

  const imageUri = `${APP_REPOSITORY_URI}:${runId}-${phase}`;

  const { taskDefinition } = await ecs.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: APP_TASK_FAMILY })
  );

  const containerDefinitions = taskDefinition.containerDefinitions.map((c) =>
    c.name === APP_CONTAINER_NAME ? { ...c, image: imageUri } : c
  );

  const registered = await ecs.send(
    new RegisterTaskDefinitionCommand({
      family: taskDefinition.family,
      taskRoleArn: taskDefinition.taskRoleArn,
      executionRoleArn: taskDefinition.executionRoleArn,
      networkMode: taskDefinition.networkMode,
      containerDefinitions,
      requiresCompatibilities: taskDefinition.requiresCompatibilities,
      cpu: taskDefinition.cpu,
      memory: taskDefinition.memory,
    })
  );

  const newTaskDefinitionArn = registered.taskDefinition.taskDefinitionArn;

  await ecs.send(
    new UpdateServiceCommand({
      cluster: CLUSTER_NAME,
      service: APP_SERVICE_NAME,
      taskDefinition: newTaskDefinitionArn,
    })
  );

  return { imageUri, taskDefinitionArn: newTaskDefinitionArn };
};
