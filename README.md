## Image Optimization

Images are usually the heaviest components of a web page, both in terms of bytes and number of HTTP requests. Optimizing images on your website is critical to improve your users’ experience, reduce delivery costs and enhance your position in search engine ranking. For example, Google’s Largest Contentful Paint metric in their search ranking algorithm is highly impacted by how much you optimize the images on your website. In the solution, we provide you with a simple and performant solution for image optimization using serverless components such as Amazon CloudFront, Amazon S3 and AWS Lambda.

The proposed architecture is suitable for most common use cases. Image transformation is executed centrally in an AWS Region, only when the image hasn’t been already transformed and stored. The available transformations include resizing and formatting, but can be extended to more operations if needed. Both transformations can be requested by the front-end, with the possibility of automatic format selection done on server side. The architecture is based on S3 for storage, CloudFront for content delivery, and Lambda for image processing. The request flow is explained in the next diagram:

<img src="architecture.png" width="900">

1. The user sends a HTTP request for an image with specific transformations, such as encoding and size. The transformations are encoded in the URL, more precisely as query parameters. An example URL would look like this: https://examples.com/images/cats/mycat.jpg?format=webp&width=200.
2. The request is processed by a nearby CloudFront edge location providing the best performance. Before passing the request upstream, a CloudFront Function is executed on viewer request event to rewrite the request URL. CloudFront Functions is a feature of CloudFront that allows you to write lightweight functions in JavaScript for high-scale, latency-sensitive CDN customizations. In our architecture, we rewrite the URL to validate the requested transformations and normalize the URL by ordering transformations and convert them to lower case to increase the cache hit ratio. When an automatic transformation is requested, the function also decides about the best one to apply. For example, if the user asks for the most optimized image format (JPEG, WebP, or AVIF) using the directive format=auto, CloudFront Function will select the best format based on the Accept header present in the request.
3. If the requested image is already cached in CloudFront then there will be a cache hit and the image is returned from CloudFront cache. To increase the cache hit ratio, we enable Origin shield, a feature of CloudFront that acts as an additional layer of caching before the origin, to further offload it from requests. If the Image is not in CloudFront cache, then the request will be forwarded to an S3 bucket, which is created to store the transformed images. If the requested image is already transformed and stored in S3, then it is simply served and cached in CloudFront.
4. Otherwise, S3 will respond with a 403 error code, which is detected by CloudFront’s Origin Failover. Thanks to this native feature, CloudFront retries the same URL but this time using the secondary origin based on Lambda function URL. When invoked, the Lambda function downloads the original image from another S3 bucket, where original images are stored, transforms it using Sharp library, stores the transformed image in S3, then serve it through CloudFront where it will be cached for future requests.

Note the following:

* The transformed image is stored in S3 with a lifecycle policy that deletes it after a certain duration (default of 90 days) to reduce the storage cost. Ideally, you’d set this value according to the duration after which the number of requests to a new image drops significantly. They are created with the same key as the original image in addition to a suffix based on the normalized image transformations. For example, the transformed image in response to /mycat.jpg?format=auto&width=200 would be stored with the key /mycat.jpg/format=webp,width=200 if the automatically detected format was webp. To remove all generated variants of the same image in S3, delete all files listed under the key of the original image /mycat.jpg/*. Transformed images are added to S3 with a Cache-Control header of 1 year. If you need to invalidate all cached variants of an image in CloudFront, use the following invalidation pattern: /mycat.jpg*.
* To prevent from unauthorized invocations of the Lambda function, CloudFront is configured to send a secret key in a Custom origin header, which is validated in the Lambda function before processing the image.

## Deploy the solution using CDK
AWS CDK is an open-source software development framework used to define cloud infrastructure in code and provision it through AWS CloudFormation. Follow these steps in your command line to deploy the image optimization solution with CDK, using the region and account information configured in your AWS CLI.

```
git clone https://github.com/aws-samples/image-optimization.git 
cd image-optimization
npm install
cdk bootstrap
npm run build
cdk deploy
```

When the deployment is completed within minutes, the CDK output will include the domain name of the CloudFront distribution created for image optimization (ImageDeliveryDomain =YOURDISTRIBUTION.cloudfront.net). The stack will include an S3 bucket with sample images (OriginalImagesS3Bucket = YourS3BucketWithOriginalImagesGeneratedName). To verify that it is working properly, test the following optimized image URL https:// YOURDISTRIBUTION.cloudfront.net/images/rio/1.jpeg?format=auto&width=300.

Note that when deploying in production, it’s recommended to use an existing S3 bucket where your images are stored. To do that, deploy the stack in the same region of your S3 bucket, using the following parameter: cdk deploy -c S3_IMAGE_BUCKET_NAME=’YOUR_S3_BUCKET_NAME’. The solution allows you to configure other parameters such as whether you want to store transformed images in S3 (STORE_TRANSFORMED_IMAGES), the duration after which transformed images are automatically removed from S3 (S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION), and the Cache-Control header used with transformed images (S3_TRANSFORMED_IMAGE_CACHE_TTL).

## Clean up resources

To remove cloud resources created for this solution, just execute the following command:

```
cdk destroy
```

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

