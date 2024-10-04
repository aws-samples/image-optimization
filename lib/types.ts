export type ImageProcessingLambdaEnvironment = ImageProcessingLambdaEnvironmentBase & OptionalTransformedImageBucketName;

type ImageProcessingLambdaEnvironmentBase = {
  maxImageSize: string,
  originalImageBucketName: string,
  transformedImageCacheTTL: string,
};

type OptionalTransformedImageBucketName = Partial<{
  transformedImageBucketName: string
}>;

