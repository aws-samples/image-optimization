// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { aws_s3 as s3, aws_s3_deployment as s3deploy, Duration, CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { readContext } from './cdk-context-utils';
import { sampleWebsite } from './image-optimization-sample-website';
import { imageOptimizationSolution } from './image-optimization-solution';
import { getOriginShieldRegion } from './origin-shield';

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Load stack parameters related to architecture from CDK context
    const context = readContext(this.node);

    const CORS_ENABLED = context.boolean('CLOUDFRONT_CORS_ENABLED', true);
    const DEPLOY_SAMPLE_WEBSITE = context.boolean('DEPLOY_SAMPLE_WEBSITE');
    const LAMBDA_MEMORY = context.number('LAMBDA_MEMORY', 1500);
    const LAMBDA_TIMEOUT_SECONDS = context.number('LAMBDA_TIMEOUT', 60);
    const MAX_IMAGE_SIZE = context.number('MAX_IMAGE_SIZE', 4700000);
    const ORIGIN_SHIELD_REGION = context.string('CLOUDFRONT_ORIGIN_SHIELD_REGION', getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1'));
    const S3_ORIGINAL_IMAGE_BUCKET_NAME = context.stringOrUndefined('S3_IMAGE_BUCKET_NAME');
    const S3_TRANSFORMED_IMAGE_CACHE_CONTROL = context.string('S3_TRANSFORMED_IMAGE_CACHE_TTL', 'max-age=31622400');
    const S3_TRANSFORMED_IMAGE_EXPIRATION_DAYS = context.number('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION', 90);
    const STORE_TRANSFORMED_IMAGES = context.boolean('STORE_TRANSFORMED_IMAGES', true);

    // If true, this stack will deploy an additional, sample website to showcase the solution
    // Architecture of the sample website is described at https://aws.amazon.com/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda/
    if (DEPLOY_SAMPLE_WEBSITE) {
      const sampleWebsiteDelivery = sampleWebsite(this);
      new CfnOutput(this, 'SampleWebsiteDomain', {
        description: 'Sample website domain',
        value: sampleWebsiteDelivery.distributionDomainName
      });
    }

    // For original images, use existing S3 bucket if provided, otherwise create a new one with sample images
    let originalImageBucket: s3.IBucket;
    if (S3_ORIGINAL_IMAGE_BUCKET_NAME) {
      originalImageBucket = s3.Bucket.fromBucketName(this, 'imported-original-image-bucket', S3_ORIGINAL_IMAGE_BUCKET_NAME);
    } else {
      originalImageBucket = new s3.Bucket(this, 's3-sample-original-image-bucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        autoDeleteObjects: true,
      });
      new s3deploy.BucketDeployment(this, 'deploy-website', {
        sources: [s3deploy.Source.asset('./image-sample')],
        destinationBucket: originalImageBucket,
        destinationKeyPrefix: 'images/rio/',
      });
    };
    new CfnOutput(this, 'original-images-s3-bucket', {
      description: 'S3 bucket storing original images',
      value: originalImageBucket.bucketName
    });

    // Create Amazon CloudFront distribution to deliver optimized images
    const imageOptimization = imageOptimizationSolution(this, {
      corsEnabled: CORS_ENABLED,
      lambdaMemory: LAMBDA_MEMORY,
      lambdaTimeout: Duration.seconds(LAMBDA_TIMEOUT_SECONDS),
      maxImageSizeBytes: MAX_IMAGE_SIZE,
      originalImageBucket: originalImageBucket,
      originShieldRegion: ORIGIN_SHIELD_REGION,
      storeTransformedImages: STORE_TRANSFORMED_IMAGES,
      transformedImageCacheControl: S3_TRANSFORMED_IMAGE_CACHE_CONTROL,
      transformedImageExpiration: Duration.days(S3_TRANSFORMED_IMAGE_EXPIRATION_DAYS),
    });
    new CfnOutput(this, 'image-delivery-domain', {
      description: 'Image delivery domain',
      value: imageOptimization.distributionDomainName
    });
  }
}
