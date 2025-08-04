// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Fn, Stack, StackProps, RemovalPolicy, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, Duration, CfnOutput, aws_logs as logs } from 'aws-cdk-lib'
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront"
import { Construct } from 'constructs'
import { getOriginShieldRegion } from './origin-shield'

type ImageDeliveryCacheBehaviorConfig = {
  origin: any
  compress: any
  viewerProtocolPolicy: any
  cachePolicy: any
  functionAssociations: any
  responseHeadersPolicy?: any
}

type LambdaEnv = {
  originalImageBucketName: string,
  transformedImageBucketName?: any
  transformedImageCacheTTL: string,
  maxImageSize: string,
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // CloudFront parameters
    const CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1')
    // Parameters of transformed images
    const S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400'

    // Whether to deploy a sample website referenced in https://aws.amazon.com/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda/
    const DEPLOY_SAMPLE_WEBSITE = 'false'

    const S3_IMAGE_BUCKET_NAME = process.env.S3_IMAGE_BUCKET_NAME
    if(!S3_IMAGE_BUCKET_NAME) {
      throw new Error('S3_IMAGE_BUCKET_NAME environment variable is not set.')
    }

    const originalImageBucket = s3.Bucket.fromBucketName(this, 'imported-original-image-bucket', S3_IMAGE_BUCKET_NAME)
    new CfnOutput(this, 'Lighthouse-Image-Uploads', {
      description: 'S3 bucket where lighthouse image uploads are stored',
      value: originalImageBucket.bucketName
    })

    const S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '7' // in days
    const transformedImageBucket = new s3.Bucket(this, 's3-transformed-image-bucket', {
      bucketName: S3_IMAGE_BUCKET_NAME + '-transformed',
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
        },
      ],
    })

    const imageProcessing = new lambda.Function(
      this, 'image-optimization',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('functions/image-processing'),
        timeout: Duration.seconds(60),  // 60 seconds
        memorySize: 1500,               // 1500 MB
        environment: {
          originalImageBucketName: originalImageBucket.bucketName,
          transformedImageBucketName: transformedImageBucket.bucketName,
          transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
          // Max image size in bytes. If generated images are stored on S3, bigger images are generated, stored on S3
          // and request is redirected to the generated image. Otherwise, an application error is sent.
          maxImageSize: "4700000", // 4.7 MB
        },
        logRetention: logs.RetentionDays.ONE_DAY,
      }
    )

    // Enable Lambda URL
    const imageProcessingURL = imageProcessing.addFunctionUrl()

    // Leverage CDK Intrinsics to get the hostname of the Lambda URL
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url)




    // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
    const imageOrigin = new origins.OriginGroup({
      primaryOrigin: new origins.S3Origin(transformedImageBucket, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
      }),
      fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
      }),
      fallbackStatusCodes: [403, 500, 503, 504],
    })

    // Image Processing Lambda IAM Permissions
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: [
          // Read Source Bucket Contents
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: ['arn:aws:s3:::' + originalImageBucket.bucketName + '/*'],
          }),
          // List Source Bucket
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: ['arn:aws:s3:::' + originalImageBucket.bucketName]
          }),
          // Write Transformed Images to Transformed Bucket
          new iam.PolicyStatement({
            actions: ['s3:PutObject'],
            resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
          })
        ],
      }),
    )

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'urlRewrite', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js', }),
      functionName: `urlRewriteFunction${this.node.addr}`,
    })

    const imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
      origin: imageOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: false,
      cachePolicy: new cloudfront.CachePolicy(this, `ImageCachePolicy${this.node.addr}`, {
        defaultTtl: Duration.hours(24),
        maxTtl: Duration.days(365),
        minTtl: Duration.seconds(0)
      }),
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    }

    const CLOUDFRONT_CORS_ENABLED = 'true'

    if (CLOUDFRONT_CORS_ENABLED === 'true') {
      // Creating a custom response headers policy. CORS allowed for all origins.
      const imageResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${this.node.addr}`, {
        responseHeadersPolicyName: `ImageResponsePolicy${this.node.addr}`,
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.seconds(600),
          originOverride: false,
        },
        // recognizing image requests that were processed by this solution
        customHeadersBehavior: {
          customHeaders: [
            { header: 'x-aws-image-optimization', value: 'v1.0', override: true },
            { header: 'vary', value: 'accept', override: true },
          ],
        }
      })
      imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = imageResponseHeadersPolicy
    }
    const imageDelivery = new cloudfront.Distribution(this, 'imageDeliveryDistribution', {
      comment: 'image optimization - image delivery',
      defaultBehavior: imageDeliveryCacheBehaviorConfig
    })

    // ADD OAC between CloudFront and LambdaURL
    const oac = new cloudfront.CfnOriginAccessControl(this, "OAC", {
      originAccessControlConfig: {
        name: `oac${this.node.addr}`,
        originAccessControlOriginType: "lambda",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    })

    const cfnImageDelivery = imageDelivery.node.defaultChild as CfnDistribution

    // If set to false, transformed images are not stored in S3, and all image requests land on Lambda
    const STORE_TRANSFORMED_IMAGES = 'true'
    cfnImageDelivery.addPropertyOverride(`DistributionConfig.Origins.${(STORE_TRANSFORMED_IMAGES === 'true')?"1":"0"}.OriginAccessControlId`, oac.getAtt("Id"))

    imageProcessing.addPermission("AllowCloudFrontServicePrincipal", {
      principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
      action: "lambda:InvokeFunctionUrl",
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${imageDelivery.distributionId}`
    })

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery',
      value: imageDelivery.distributionDomainName
    })
  }
}
