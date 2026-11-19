#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from '../lib/image-optimization-stack';


const app = new cdk.App();
// Stack name defaults to ImgTransformationStack. It can be overridden with
// `-c stackName=...` (for example the esc-imgopt prefix used for ESC deploys)
// without affecting existing commercial-region deployments.
const stackName = app.node.tryGetContext('stackName') || 'ImgTransformationStack';
new ImageOptimizationStack(app, stackName, {

});

