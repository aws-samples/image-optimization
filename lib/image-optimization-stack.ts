import * as path from "path";
import * as fs from "fs";
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cforigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as waf from "aws-cdk-lib/aws-wafv2";
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { AwsCustomResource, PhysicalResourceId, AwsCustomResourcePolicy } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { createHash } from 'crypto';
import { products, defaultUser } from '../ddb-data';
import { wafRules } from '../waf-rules';
import { stackConfig } from '../stack-config';


export class StoreInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DyanmoDB tables to store users and prodcts data
    const usersTable = new dynamodb.Table(this, "usersTable", {
      partitionKey: {
        name: "username",
        type: dynamodb.AttributeType.STRING
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    const productsTable = new dynamodb.Table(this, "productsTable", {
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // fill tables with initial data
    new AwsCustomResource(this, 'initDDBresource', {
      onCreate: {
        service: 'DynamoDB',
        action: 'BatchWriteItem',
        parameters: {
          RequestItems: {
            [productsTable.tableName]: products.map(product => ({
              PutRequest: {
                Item: {
                  id: { S: product.id },
                  name: { S: product.name },
                  description: { S: product.description },
                  price: { N: `${product.price}` },
                  image: { S: product.image },
                }
              }
            })),
            [usersTable.tableName]: [
              {
                PutRequest: {
                  Item: defaultUser,
                }
              }

            ]
          }
        },
        physicalResourceId: PhysicalResourceId.of('initDDBresource'),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE, //TODO make it more restrictive
      }),
    });

    // S3 bucket holding original images
    const originalImageBucket = new cdk.aws_s3.Bucket(this, 's3-sample-original-image-bucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
    });

    // adding initial images to it
    new cdk.aws_s3_deployment.BucketDeployment(this, 'ProductImages', {
      sources: [cdk.aws_s3_deployment.Source.asset('../assets/images')],
      destinationBucket: originalImageBucket,
      destinationKeyPrefix: 'images/',
    });

    // Creating cloudwatch RUM

    const cwRumIdentityPool = new cognito.CfnIdentityPool(this, 'cw-rum-identity-pool', {
      allowUnauthenticatedIdentities: true,
    });

    const cwRumUnauthenticatedRole = new iam.Role(this, 'cw-rum-unauthenticated-role', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          "StringEquals": {
            "cognito-identity.amazonaws.com:aud": cwRumIdentityPool.ref
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "unauthenticated"
          }
        },
        "sts:AssumeRoleWithWebIdentity"
      )
    });

    const rumApplicationName = 'RecyleBinBoutiqueRUM';

    cwRumUnauthenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "rum:PutRumEvents"
      ],
      resources: [
        `arn:aws:rum:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:appmonitor/${rumApplicationName}`
      ]
    }));

    new cognito.CfnIdentityPoolRoleAttachment(this,
      'cw-rum-identity-pool-role-attachment',
      {
        identityPoolId: cwRumIdentityPool.ref,
        roles: {
          "unauthenticated": cwRumUnauthenticatedRole.roleArn
        }
      });

    new cdk.aws_rum.CfnAppMonitor(this, 'MyCfnAppMonitor', {
      domain: 'www.dummy.com',
      name: rumApplicationName,
      appMonitorConfiguration: {
        allowCookies: true,
        enableXRay: false,
        sessionSampleRate: 1,
        telemetries: ['errors', 'performance', 'http'],
        identityPoolId: cwRumIdentityPool.ref,
        guestRoleArn: cwRumUnauthenticatedRole.roleArn
      },

    });

    // S3 bucket holding trasnformed images (resized and reformatted)
    const transformedImageBucket = new s3.Bucket(this, 's3-transformed-image-bucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(stackConfig.S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION),
        },
      ],
    });

    // Create Lambda URL for image processing
    var imageProcessing = new lambda.Function(this, 'image-optimization-lambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing-lambda'),
      timeout: cdk.Duration.seconds(stackConfig.LAMBDA_TIMEOUT),
      memorySize: stackConfig.LAMBDA_MEMORY,
      environment: {
        originalImageBucketName: originalImageBucket.bucketName,
        transformedImageCacheTTL: stackConfig.S3_TRANSFORMED_IMAGE_CACHE_TTL,
        transformedImageBucketName: transformedImageBucket.bucketName
      },
      logRetention: cdk.aws_logs.RetentionDays.ONE_DAY,
    });
    // IAM policy to allow this lambda to read/write images from the relevant buckets
    const s3ReadOriginalImagesPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::' + originalImageBucket.bucketName + '/*'],
    });

    var s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
    });
    var iamPolicyStatements = [s3ReadOriginalImagesPolicy, s3WriteTransformedImagesPolicy];

    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: iamPolicyStatements,
      }),
    );
    const imageProcessingURL = imageProcessing.addFunctionUrl();
    const imageProcessingDomainName = cdk.Fn.parseDomainName(imageProcessingURL.url);

    // Create a CloudFront Function for detecting optimal format, validating inputs and rewriting url
    const imageURLformatting = new cloudfront.Function(this, 'imageURLformatting', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/cloudfront-function-image-url-formatting/index.js' }),
      functionName: `imageURLformatting${this.node.addr}`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // Create a VPC
    const vpc = new ec2.Vpc(this, 'store_vpc', {
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ]
    });


    // Create a security group locked to CloudFront IPs
    // first get the CloudFront prefix list in the CDK deployment region using a custom resource

    const prefixListId = new AwsCustomResource(this, 'GetPrefixListId', {
      onCreate: {
        service: 'EC2',
        action: 'DescribeManagedPrefixListsCommand',
        parameters: {
          Filters: [
            {
              Name: 'prefix-list-name',
              Values: ['com.amazonaws.global.cloudfront.origin-facing'],
            },
          ],
        },
        physicalResourceId: PhysicalResourceId.of('GetPrefixListId'),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,//TODO make it more restrictive
      }),
    }).getResponseField('PrefixLists.0.PrefixListId');

    const securityGroup = new ec2.SecurityGroup(this, 'MySecurityGroup', {
      vpc,
      description: 'Allow access from CloudFront IPs on port 3000, and any IP on port 22',
      allowAllOutbound: true
    });
    securityGroup.addIngressRule(
      ec2.Peer.prefixList(prefixListId),
      ec2.Port.tcp(3000),
      'Allow port 3000 on IPv4 from CloudFront '
    );
    // For troubleshooting, but in real world it would be restrcited.
    securityGroup.addIngressRule(
      ec2.Peer.ipv4('0.0.0.0/0'),
      ec2.Port.tcp(22),
      'Allow SSH'
    );

    // Create an IAM role for the EC2 instance with DynamoDB read/write permissions to the role
    const role = new iam.Role(this, 'MyEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    productsTable.grantReadWriteData(role);
    usersTable.grantReadWriteData(role);

    // Get the latest Ubuntu AMI and Create the EC2 instance
    const ubuntu = ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/focal/stable/current/amd64/hvm/ebs-gp2/ami-id',
      { os: ec2.OperatingSystemType.LINUX }
    );
    const instance = new ec2.Instance(this, 'store_backend_ec', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL),
      machineImage: ubuntu,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: securityGroup,
      role: role,
      associatePublicIpAddress: true,
    });

    // Create a WebACL and populate it with rules
    const webACLName = 'RecycleBinBoutiqueACL';
    const webACL = new waf.CfnWebACL(this, "webACL", {
      name: webACLName,
      defaultAction: { allow: {} },
      scope: "CLOUDFRONT",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "RecycleBinBoutiqueACL",
        sampledRequestsEnabled: true,
      },
      rules: wafRules,
    });

    // Get the url used for the Client side javascript integration
    const wafCR = new AwsCustomResource(this, 'WAFproperties', {
      onCreate: {
        service: 'WAFv2',
        action: 'GetWebACL',
        parameters: {
          Id: webACL.attrId,
          Name: webACLName,
          Scope: 'CLOUDFRONT'
        },
        outputPaths: ['ApplicationIntegrationURL'],
        physicalResourceId: PhysicalResourceId.of('WAFproperties'),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE, //TODO make it more restrictive
      }),
    });
    const wafIntegrationURL = wafCR.getResponseField('ApplicationIntegrationURL');

    // get the paramters of the RUM script tag
    const rumParameters = new AwsCustomResource(this, 'RumParameters', {
      onCreate: {
        service: 'RUM',
        action: 'GetAppMonitor',
        parameters: {
          Name: rumApplicationName,
        },
        physicalResourceId: PhysicalResourceId.of('RumParameters'), 
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE, //TODO make it more restrictive
      }),
    });
    const rumMonitorId = rumParameters.getResponseField('AppMonitor.Id');
    const rumMonitorIdentityPoolId = rumParameters.getResponseField('AppMonitor.AppMonitorConfiguration.IdentityPoolId');

    // Script to bootstrap the Nextjs app on EC2
    instance.addUserData(
      '#!/bin/bash',
      'sudo apt update',
      'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -',
      'sudo apt-get install -y nodejs',
      'sudo npm install -g npm@latest',
      'sudo npm install pm2 -g',
      `git clone ${stackConfig.GITHUB_REPO}`,
      'cd recycle-bin-boutique/store-app',
      `echo '{"products_ddb_table" : "${productsTable.tableName}", "users_ddb_table": "${usersTable.tableName}","login_secret_key": "${createHash('md5').update(this.node.addr).digest('hex')}","aws_region": "${this.region}", "waf_url": "${wafIntegrationURL}challenge.compact.js", "rumMonitorId": "${rumMonitorId}", "rumMonitorIdentityPoolId": "${rumMonitorIdentityPoolId}"}' > aws-backend-config.json`,
      'npm install',
      'npm run build',
      'pm2 start npm --name nextjs-app -- run start -- -p 3000'
    );

    // Create a CloudFront distribution TODO add security headers

    // Create KeyValueStore that will store the engine rules
    const kvs = new cloudfront.KeyValueStore(this, 'KeyValueStore', {
      keyValueStoreName: 'html-rules-kvs',
    });

    // Replace KVS id in the CloudFront Function code, then minify the code
    let htmlRulesRequestFunctionCode = fs.readFileSync(path.join(__dirname, "../functions/cloudfront-function-html-rules/request-index.js"), 'utf-8');
    htmlRulesRequestFunctionCode = htmlRulesRequestFunctionCode.replace(/__KVS_ID__/g, kvs.keyValueStoreId);

    const htmlRulesRequestFunction = new cloudfront.Function(this, 'htmlRulesRequestFunction', {
      code: cloudfront.FunctionCode.fromInline(htmlRulesRequestFunctionCode),
      functionName: `htmlRulesReqCFF${this.node.addr}`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: kvs,
    });

    const htmlRulesResponseFunction = new cloudfront.Function(this, 'htmlRulesResponseFunction', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/cloudfront-function-html-rules/response-index.js' }),
      functionName: `htmlRulesRespCFF${this.node.addr}`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const backendOrigin = new cforigins.HttpOrigin(instance.instancePublicDnsName, {
      httpPort: 3000,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
      responseHeadersPolicyName: 'RecycleBinBoutiqueRHP',
      comment: 'A default policy for the Recycle Bin Boutique',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: 'default-src https:;', override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.seconds(600), includeSubdomains: true, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      serverTimingSamplingRate: 100,
    });

    const cdn = new cloudfront.Distribution(this, 'store-cdn', {
      comment: 'CloudFront to serve the Recycle Bin Boutique',
      webAclId: webACL.attrArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      publishAdditionalMetrics: true,
      defaultBehavior: {
        origin: backendOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: new cloudfront.CachePolicy(this, "htmlCachePolicy", {
          cachePolicyName: "htmlCachePolicy",
          comment: "caching for short time with token cookie part of cache key",
          cookieBehavior: cloudfront.CacheCookieBehavior.allowList('token'),
          minTtl: cdk.Duration.minutes(2),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022, //TODO could break with ALB
        responseHeadersPolicy: responseHeadersPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: htmlRulesRequestFunction,
        },
        {
          eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
          function: htmlRulesResponseFunction,
        },
        ],
      },
      additionalBehaviors: {
        '*.css': {
          origin: backendOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022, //TODO could break with ALB
          responseHeadersPolicy: responseHeadersPolicy
        },
        '*.js': {
          origin: backendOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022, //TODO could break with ALB
          responseHeadersPolicy: responseHeadersPolicy
        },
        '/images/*': {
          origin: new cforigins.OriginGroup({
            primaryOrigin: new cforigins.S3Origin(transformedImageBucket),
            fallbackOrigin: new cforigins.HttpOrigin(imageProcessingDomainName),
            fallbackStatusCodes: [403, 500, 503, 504],
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED_FOR_UNCOMPRESSED_OBJECTS,
          responseHeadersPolicy: responseHeadersPolicy,
          compress: false,
          functionAssociations: [{
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: imageURLformatting,
          }],
        },
        '/api/*': {
          origin: backendOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: responseHeadersPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: false,
        },
      },

    });

    // ADD OAC between CloudFront and LambdaURL
    const oac = new cloudfront.CfnOriginAccessControl(this, "OAC", {
      originAccessControlConfig: {
        name: `oac${this.node.addr}`,
        originAccessControlOriginType: "lambda",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });
    const cfnImageDelivery = cdn.node.defaultChild as cloudfront.CfnDistribution;
    cfnImageDelivery.addPropertyOverride('DistributionConfig.Origins.2.OriginAccessControlId', oac.getAtt("Id"));
    imageProcessing.addPermission("AllowCloudFrontServicePrincipal", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunctionUrl",
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${cdn.distributionId}`
    })

    // Update the domain name of RUM TODO risk of drift detection
    new AwsCustomResource(this, 'RumUpdate', {
      onCreate: {
        service: 'RUM',
        action: 'UpdateAppMonitor',
        parameters: {
          Domain: cdn.distributionDomainName,
          Name: rumApplicationName,
          AppMonitorConfiguration: {
            AllowCookies: true,
            EnableXRay: false,
            SessionSampleRate: 1,
            Telemetries: ['errors', 'performance', 'http'],
            IdentityPoolId: cwRumIdentityPool.ref,
            GuestRoleArn: cwRumUnauthenticatedRole.roleArn
          }
        },
        physicalResourceId: PhysicalResourceId.of('RumUpdate'),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE, //TODO make it more restrictive
      }),
    });

    // Output cloudfront domain name
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      description: 'CloudFront domain name of the Recycle Bin Boutique',
      value: cdn.distributionDomainName
    });

  }
}
