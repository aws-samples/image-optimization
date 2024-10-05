// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_s3 as s3, aws_s3_deployment as s3deploy, CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { getContextVariables } from './cdk-context-utils';
import { getOriginShieldRegion } from './origin-shield';
import { deploySampleWebsite } from './sample-website';

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Load stack parameters related to architecture from CDK context
    const getContext = getContextVariables(this);
    const CLOUDFRONT_CORS_ENABLED = getContext.boolean('CLOUDFRONT_CORS_ENABLED', true);
    const CLOUDFRONT_ORIGIN_SHIELD_REGION = getContext.string('CLOUDFRONT_ORIGIN_SHIELD_REGION', getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1'));

    const LAMBDA_MEMORY = getContext.number('LAMBDA_MEMORY', 1500);
    const LAMBDA_TIMEOUT_SECONDS = getContext.number('LAMBDA_TIMEOUT', 60);
    const MAX_IMAGE_SIZE = getContext.number('MAX_IMAGE_SIZE', 4700000);

    const S3_IMAGE_BUCKET_NAME = getContext.stringOrUndefined('S3_IMAGE_BUCKET_NAME');
    const S3_TRANSFORMED_IMAGE_CACHE_TTL = getContext.string('S3_TRANSFORMED_IMAGE_CACHE_TTL', 'max-age=31622400');
    const S3_TRANSFORMED_IMAGE_EXPIRATION_DAYS = getContext.number('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION', 90);
    const STORE_TRANSFORMED_IMAGES = getContext.boolean('STORE_TRANSFORMED_IMAGES', true);

    // If DEPLOY_SAMPLE_WEBSITE is true, this stack will deploy an additional, sample website to see th
    if (getContext.boolean('DEPLOY_SAMPLE_WEBSITE')) {
      // Architecture of the sample website is described at https://aws.amazon.com/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda/
      deploySampleWebsite(this);
    }

    // *********************** Image Optimization Stack ***********************

    // For original images, use existing S3 bucket if provided, otherwise create a new one with sample images
    let originalImageBucket: s3.IBucket;
    if (S3_IMAGE_BUCKET_NAME) {
      originalImageBucket = s3.Bucket.fromBucketName(this, 'imported-original-image-bucket', S3_IMAGE_BUCKET_NAME);
    } else {
      originalImageBucket = new s3.Bucket(this, 's3-sample-original-image-bucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        autoDeleteObjects: true,
      });
      new s3deploy.BucketDeployment(this, 'DeployWebsite', {
        sources: [s3deploy.Source.asset('./image-sample')],
        destinationBucket: originalImageBucket,
        destinationKeyPrefix: 'images/rio/',
      });
    };
    new CfnOutput(this, 'OriginalImagesS3Bucket', {
      description: 'S3 bucket storing original images',
      value: originalImageBucket.bucketName
    });

    // Create Lambda function for image processing
    const imageProcessing = new lambda.Function(this, 'image-optimization', {
      code: lambda.Code.fromAsset('functions/image-processing'),
      environment: {
        maxImageSize: String(MAX_IMAGE_SIZE),
        originalImageBucketName: originalImageBucket.bucketName,
        transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      },
      handler: 'index.handler',
      // let downloads of original images from S3
      initialPolicy: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [`arn:aws:s3:::${originalImageBucket.bucketName}/*`]
        }),
      ],
      logRetention: logs.RetentionDays.ONE_DAY,
      memorySize: LAMBDA_MEMORY,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(LAMBDA_TIMEOUT_SECONDS),
    });

    // Enable Lambda URL and create Amazon CloudFront origin
    const imageProcessingURL = imageProcessing.addFunctionUrl();
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);
    const originProps = { originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION };
    const imageProcessingLambdaOrigin = new origins.HttpOrigin(imageProcessingDomainName, originProps);

    // Create custom response headers policy with CORS requests allowed for all origins
    const getCorsResponsePolicy = () => new cloudfront.ResponseHeadersPolicy(this, 'CorsResponsePolicy', {
      responseHeadersPolicyName: `CorsResponsePolicy${this.node.addr}`,
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET'],
        accessControlAllowOrigins: ['*'],
        accessControlMaxAge: Duration.seconds(600),
        originOverride: false,
      },
      // Recognize image requests that were processed by this solution
      customHeadersBehavior: {
        customHeaders: [
          { header: 'x-aws-image-optimization', value: 'v1.0', override: true },
          { header: 'vary', value: 'accept', override: true },
        ],
      }
    });

    // Create an S3 origin with fallback to Lambda
    const getS3OriginWithFallbackToLambda = () => {
      const transformedImageBucket = new s3.Bucket(this, 's3-transformed-image-bucket', {
        autoDeleteObjects: true,
        lifecycleRules: [{ expiration: Duration.days(S3_TRANSFORMED_IMAGE_EXPIRATION_DAYS) }],
        removalPolicy: RemovalPolicy.DESTROY,
      });
      imageProcessing.addEnvironment('transformedImageBucketName', transformedImageBucket.bucketName);
      imageProcessing.role!.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [`arn:aws:s3:::${transformedImageBucket.bucketName}/*`]
        })
      );
      return new origins.OriginGroup({
        primaryOrigin: origins.S3BucketOrigin.withOriginAccessIdentity(transformedImageBucket, originProps),
        fallbackOrigin: imageProcessingLambdaOrigin,
        fallbackStatusCodes: [403, 500, 503, 504],
      });
    };

    // Create content delivery distribution with Amazon CloudFront for optimized images
    const imageDelivery = new cloudfront.Distribution(this, 'imageDeliveryDistribution', {
      comment: 'Image Optimization - image delivery',
      defaultBehavior: {
        cachePolicy: new cloudfront.CachePolicy(this, `ImageCachePolicy${this.node.addr}`, {
          defaultTtl: Duration.hours(24),
          maxTtl: Duration.days(365),
          minTtl: Duration.seconds(0),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
        }),
        compress: false,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: new cloudfront.Function(this, 'urlRewrite', {
            code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js' }),
            functionName: `urlRewriteFunction${this.node.addr}`,
          }),
        }],
        origin: STORE_TRANSFORMED_IMAGES ? getS3OriginWithFallbackToLambda() : imageProcessingLambdaOrigin,
        responseHeadersPolicy: CLOUDFRONT_CORS_ENABLED ? getCorsResponsePolicy() : undefined,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      }
    });

    // Add OAC between CloudFront and LambdaURL
    const oac = new cloudfront.CfnOriginAccessControl(this, "OAC", {
      originAccessControlConfig: {
        name: `oac${this.node.addr}`,
        originAccessControlOriginType: "lambda",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });

    const cfnImageDelivery = imageDelivery.node.defaultChild as cloudfront.CfnDistribution;
    cfnImageDelivery.addPropertyOverride(`DistributionConfig.Origins.${STORE_TRANSFORMED_IMAGES ? "1" : "0"}.OriginAccessControlId`, oac.getAtt("Id"));
    imageProcessing.addPermission("AllowCloudFrontServicePrincipal", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunctionUrl",
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${imageDelivery.distributionId}`
    })

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery',
      value: imageDelivery.distributionDomainName
    });
  }
}
