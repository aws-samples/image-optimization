#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from '../lib/vault-thumbnail-optimization';


const app = new cdk.App();
new ImageOptimizationStack(app, 'vault-thumbnail-optimization', {

});

