// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// All regions and their ordering are taken from
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-shield.html

// Regions with Regional Edge Caches
const REC_REGIONS = {
  US_EAST_2: "us-east-2",             //  1. US East (Ohio)
  US_EAST_1: "us-east-1",             //  2. US East (N. Virginia) 
  US_WEST_2: "us-west-2",             //  3. US West (Oregon) 
  AP_SOUTH_1: "ap-south-1",           //  4. Asia Pacific (Mumbai) 
  AP_NORTHEAST_2: "ap-northeast-2",   //  5. Asia Pacific (Seoul) 
  AP_SOUTHEAST_1: "ap-southeast-1",   //  6. Asia Pacific (Singapore)
  AP_SOUTHEAST_2: "ap-southeast-2",   //  7. Asia Pacific (Sydney)
  AP_NORTHEAST_1: "ap-northeast-1",   //  8. Asia Pacific (Tokyo)
  EU_CENTRAL_1: "eu-central-1",       //  9. Europe (Frankfurt)
  EU_WEST_1: "eu-west-1",             // 10. Europe (Ireland)
  EU_WEST_2: "eu-west-2",             // 11. Europe (London)
  SA_EAST_1: "sa-east-1",             // 12. South America (São Paulo)
};

// Other supported regions
const OTHER_REGIONS = {
  US_WEST_1: "us-west-1",             // 13. US West (N. California)
  AF_SOUTH_1: "af-south-1",           // 14. Africa (Cape Town)
  AP_EAST_1: "ap-east-1",             // 15. Asia Pacific (Hong Kong)
  CA_CENTRAL_1: "ca-central-1",       // 16. Canada (Central)
  EU_SOUTH_1: "eu-south-1",           // 17. Europe (Milan)
  EU_WEST_3: "eu-west-3",             // 18. Europe (Paris)
  EU_NORTH_1: "eu-north-1",           // 19. Europe (Stockholm)
  ME_SOUTH_1: "me-south-1",           // 20. Middle East (Bahrain)
};

// Region to Origin Shield mappings based on latency.
// To be updated when new Regions are available or new RECs are added to CloudFront.
const REGION_TO_ORIGIN_SHIELD_MAPPINGS = new Map([
  [REC_REGIONS.US_EAST_2, REC_REGIONS.US_EAST_2],             //  1.
  [REC_REGIONS.US_EAST_1, REC_REGIONS.US_EAST_1],             //  2.
  [REC_REGIONS.US_WEST_2, REC_REGIONS.US_WEST_2],             //  3.
  [REC_REGIONS.AP_SOUTH_1, REC_REGIONS.AP_SOUTH_1],           //  4.
  [REC_REGIONS.AP_NORTHEAST_2, REC_REGIONS.AP_NORTHEAST_2],   //  5.
  [REC_REGIONS.AP_SOUTHEAST_1, REC_REGIONS.AP_SOUTHEAST_1],   //  6.
  [REC_REGIONS.AP_SOUTHEAST_2, REC_REGIONS.AP_SOUTHEAST_2],   //  7.
  [REC_REGIONS.AP_NORTHEAST_1, REC_REGIONS.AP_NORTHEAST_1],   //  8.
  [REC_REGIONS.EU_CENTRAL_1, REC_REGIONS.EU_CENTRAL_1],       //  9.
  [REC_REGIONS.EU_WEST_1, REC_REGIONS.EU_WEST_1],             // 10.
  [REC_REGIONS.EU_WEST_2, REC_REGIONS.EU_WEST_2],             // 11.
  [REC_REGIONS.SA_EAST_1, REC_REGIONS.SA_EAST_1],             // 12.

  [OTHER_REGIONS.US_WEST_1, REC_REGIONS.US_WEST_2],           // 13.
  [OTHER_REGIONS.AF_SOUTH_1, REC_REGIONS.EU_WEST_1],          // 14.
  [OTHER_REGIONS.AP_EAST_1, REC_REGIONS.AP_SOUTHEAST_1],      // 15.
  [OTHER_REGIONS.CA_CENTRAL_1, REC_REGIONS.US_EAST_1],        // 16.
  [OTHER_REGIONS.EU_SOUTH_1, REC_REGIONS.EU_CENTRAL_1],       // 17.
  [OTHER_REGIONS.EU_WEST_3, REC_REGIONS.EU_WEST_2],           // 18.
  [OTHER_REGIONS.EU_NORTH_1, REC_REGIONS.EU_WEST_2],          // 19.
  [OTHER_REGIONS.ME_SOUTH_1, REC_REGIONS.AP_SOUTH_1],         // 20.
]);

export const getOriginShieldRegion = (region: string) => {
  const originShieldRegion = REGION_TO_ORIGIN_SHIELD_MAPPINGS.get(region);
  if (originShieldRegion === undefined) throw new Error(`The specified region ${region} is not supported.`);

  return originShieldRegion;
}
