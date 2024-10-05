import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { ImageOptimizationStack } from "./image-optimization-stack";
import { CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { Distribution, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";

export const deploySampleWebsite = (stack: ImageOptimizationStack) => {
  const sampleWebsiteBucket = new Bucket(stack, 's3-sample-website-bucket', {
    removalPolicy: RemovalPolicy.DESTROY,
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    autoDeleteObjects: true,
  });
  new CfnOutput(stack, 'SampleWebsiteS3Bucket', {
    description: 'S3 bucket use by the sample website',
    value: sampleWebsiteBucket.bucketName
  });

  const sampleWebsiteDelivery = new Distribution(stack, 'websiteDeliveryDistribution', {
    comment: 'image optimization - sample website',
    defaultRootObject: 'index.html',
    defaultBehavior: {
      origin: S3BucketOrigin.withOriginAccessIdentity(sampleWebsiteBucket),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    }
  });
  new CfnOutput(stack, 'SampleWebsiteDomain', {
    description: 'Sample website domain',
    value: sampleWebsiteDelivery.distributionDomainName
  });
}
