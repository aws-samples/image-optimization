#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from './image-optimization-stack';


const app = new cdk.App();
new ImageOptimizationStack(app, 'ImgTransformationStack', {

});

