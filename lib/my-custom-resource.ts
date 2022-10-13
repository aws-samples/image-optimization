// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface MyCustomResourceProps {
  Url: string;
}

export class MyCustomResource extends Construct {
  public readonly hostname: string;

  constructor(scope: Construct, id: string, props: MyCustomResourceProps) {
    super(scope, id);


    const onEvent = new lambda.SingletonFunction(this, 'Singleton', {
      uuid: 'f7d4f730-4ee1-11e8-9c2d-fa7ae01bbebc',
      code: lambda.Code.fromAsset('functions/custom-resource'),
      handler: 'index.on_event',
      timeout: cdk.Duration.seconds(300),
      runtime: lambda.Runtime.PYTHON_3_9,
      logRetention: logs.RetentionDays.ONE_DAY,
    });

    const myProvider = new cr.Provider(this, 'MyProvider', {
      onEventHandler: onEvent,
      logRetention: logs.RetentionDays.ONE_DAY  
    });

    const resource = new cdk.CustomResource(this, 'Resource1', { serviceToken: myProvider.serviceToken, properties: props });

    this.hostname = resource.getAtt('HostName').toString();

  }
}