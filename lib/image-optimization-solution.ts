// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  Duration, Fn, RemovalPolicy, Stack
} from 'aws-cdk-lib';

type ImageProcessingProps = {
  corsEnabled: boolean,
  originalImageBucket: s3.IBucket,
  originShieldRegion: string,
  lambdaMemory: number,
  lambdaTimeout: Duration,
  maxImageSizeBytes: number,
  transformedImageCacheControl: string,
  transformedImageExpiration: Duration,
  storeTransformedImages: boolean,
}

export const imageOptimizationSolution = (stack: Stack, props: ImageProcessingProps) => {
  const {
    corsEnabled,
    originalImageBucket,
    originShieldRegion,
    lambdaMemory,
    lambdaTimeout,
    maxImageSizeBytes,
    transformedImageCacheControl,
    transformedImageExpiration,
    storeTransformedImages,
  } = props;

  // Create Lambda function for image processing
  const imageProcessing = new lambda.Function(stack, 'image-optimization', {
    code: lambda.Code.fromAsset('functions/image-processing'),
    environment: {
      maxImageSize: String(maxImageSizeBytes),
      originalImageBucketName: originalImageBucket.bucketName,
      transformedImageCacheTTL: transformedImageCacheControl,
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
    memorySize: lambdaMemory,
    runtime: lambda.Runtime.NODEJS_20_X,
    timeout: lambdaTimeout,
  });

  // Enable Lambda URL and create Amazon CloudFront origin
  const imageProcessingURL = imageProcessing.addFunctionUrl();
  const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);
  const imageProcessingLambdaOrigin = new origins.HttpOrigin(imageProcessingDomainName, { originShieldRegion });

  // Create custom response headers policy with CORS requests allowed for all origins
  const getCorsResponsePolicy = () => new cloudfront.ResponseHeadersPolicy(stack, 'cors-response-policy', {
    responseHeadersPolicyName: `CorsResponsePolicy${stack.node.addr}`,
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
      ]
    }
  });

  // Create an S3 origin with fallback to Lambda
  const getS3OriginWithFallbackToLambda = () => {
    const transformedImageBucket = new s3.Bucket(stack, 's3-transformed-image-bucket', {
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: transformedImageExpiration }],
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
      primaryOrigin: origins.S3BucketOrigin.withOriginAccessIdentity(transformedImageBucket, { originShieldRegion }),
      fallbackOrigin: imageProcessingLambdaOrigin,
      fallbackStatusCodes: [403, 500, 503, 504],
    });
  };

  // Create content delivery distribution with Amazon CloudFront for optimized images
  const imageDelivery = new cloudfront.Distribution(stack, 'image-delivery-distribution', {
    comment: 'Image Optimization - image delivery',
    defaultBehavior: {
      cachePolicy: new cloudfront.CachePolicy(stack, `ImageCachePolicy${stack.node.addr}`, {
        defaultTtl: Duration.hours(24),
        maxTtl: Duration.days(365),
        minTtl: Duration.seconds(0),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
      }),
      compress: false,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: new cloudfront.Function(stack, 'urlRewrite', {
          code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js' }),
          functionName: `urlRewriteFunction${stack.node.addr}`,
        })
      }],
      origin: storeTransformedImages ? getS3OriginWithFallbackToLambda() : imageProcessingLambdaOrigin,
      responseHeadersPolicy: corsEnabled ? getCorsResponsePolicy() : undefined,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    }
  });

  // Add OAC between CloudFront and LambdaURL
  const oac = new cloudfront.CfnOriginAccessControl(stack, 'origin-access-control', {
    originAccessControlConfig: {
      name: `oac${stack.node.addr}`,
      originAccessControlOriginType: 'lambda',
      signingBehavior: 'always',
      signingProtocol: 'sigv4',
    }
  });

  const cfnImageDelivery = imageDelivery.node.defaultChild as cloudfront.CfnDistribution;
  cfnImageDelivery.addPropertyOverride(`DistributionConfig.Origins.${storeTransformedImages ? '1' : '0'}.OriginAccessControlId`, oac.getAtt('Id'));
  imageProcessing.addPermission('AllowCloudFrontServicePrincipal', {
    principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
    action: 'lambda:InvokeFunctionUrl',
    sourceArn: `arn:aws:cloudfront::${stack.account}:distribution/${imageDelivery.distributionId}`
  });

  return imageDelivery;
}
