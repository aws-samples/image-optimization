## Image Optimization

Images are usually the heaviest components of a web page, both in terms of bytes and number of HTTP requests. Optimizing images on your website is critical to improve your users’ experience, reduce delivery costs and enhance your position in search engine ranking. For example, Google’s Largest Contentful Paint metric in their search ranking algorithm is highly impacted by how much you optimize the images on your website. In the solution, we provide you with a simple and performant solution for image optimization using serverless components such as Amazon CloudFront, Amazon S3 and AWS Lambda.

The proposed architecture is suitable for most common use cases. Image transformation is executed centrally in an AWS Region, only when the image hasn’t been already transformed and stored. The available transformations include resizing and formatting, but can be extended to more operations if needed. Both transformations can be requested by the front-end, with the possibility of automatic format selection done on server side. The architecture is based on S3 for storage, CloudFront for content delivery, and Lambda for image processing. The request flow is explained in the next diagram:

<img src="architecture.png" width="900">

1. The user sends a HTTP request for an image with specific transformations, such as encoding and size. The transformations are encoded in the URL, more precisely as query parameters. An example URL would look like this: https://exmaples.com/images/cats/mycat.jpg?format=webp&width=200.
2. The request is processed by a nearby CloudFront edge location providing the best performance. Before passing the request upstream, a CloudFront Function is executed on viewer request event to rewrite the request URL. CloudFront Functions is a feature of CloudFront that allows you to write lightweight functions in JavaScript for high-scale, latency-sensitive CDN customizations. In our architecture, we rewrite the URL to:
    1. Validate the requested transformations.
    2. Normalize the URL by ordering transformations and convert them to lower case to increase the cache hit ratio.
    3. When an automatic transformation is requested, decide about the best one to apply. For example, if the user asks for the most optimized image format (JPEG,WebP, or AVIF) using the directive format=auto, CloudFront Function will select the best format based on the Accept header present in the request.
3. If the requested image is already cached in CloudFront then there will be a cache hit and the image is returned from CloudFront cache.To increase the cache hit ratio, we enable Origin shield, a feature of CloudFront that acts as an additional layer of caching before the origin, to further offload it from requests. If the Image is not in CloudFront cache, then the request will be forwarded to an S3 bucket, which is created to store the transformed images. If the requested image is already transformed and stored in S3, then it is simply served and cached in CloudFront.
4. Otherwise, S3 will respond with a 403 error code, which is detected by CloudFront’s Origin Failover. Thanks to this native feature, CloudFront retries the same URL but this time using the secondary origin based on Lambda function URL. When invoked, the Lambda function downloads the original image from another S3 bucket, transforms it using Sharp library, stores the transformed image in S3, then serve it through CloudFront where it will be cached for future requests. Note the following:
    1. The transformed image is stored in S3 with a lifecycle policy that deletes it after a certain duration to reduce the storage cost. Ideally, you’d set this value according to the duration after which your images stop being popular. They are created with the same key as the original image in addition to a suffix based on the normalized image transformations. For example, the transformed image in response to /mycat.jpg?format=auto&width=200 would be stored with the key /mycat.jpg/format=webp,width=200. To remove all variants of the same image, delete all files listed under key of the original image /mycat.jpg/*. Transformed Images are added to S3 with a Cache-Control header of 1 year. If you need to invalidate all cached variants of an image in CloudFront, use the following invalidation pattern: /mycat.jpg*.
    2. For additional access control, CloudFront is configured to send a secret key in a Custom origin header, which is validated in the Lambda code before processing the image.

## Deploy the solution using CDK
AWS CDK is an open-source software development framework to define cloud infrastructure in code and provision it through AWS CloudFormation. Follow these steps in your command line to deploy the image optimization solution using CDK, using the region and account information configured in your AWS CLI. 

```
git clone https://github.com/aws-samples/image-optimization.git 
cd image-optimization
npm install
cdk bootstrap
npm run build
cdk deploy
```

When the deployment is completed within minutes, the CDK output will include the domain name of the CloudFront distribution created for image optimization (e.g. YOURDISTRIBUTION.CLOUDFRONT.NET). The stack will include an S3 bucket with sample images. To verify that it is working properly, test the following optimized image URL https://[ YOURDISTRIBUTION.CLOUDFRONT.NET]/images/rio/1.jpeg?format=auto&width=300. 

Note that when deploying in production, it’s recommended to use an existing S3 bucket where your images are stored. To do that, deploy the stack using the following parameter: cdk deploy -c S3_IMAGE_BUCKET_NAME=’YOUR_S3_BUCKET_NAME’. 



## License

This library is licensed under the MIT-0 License. See the LICENSE file.

