import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Construct } from 'constructs';

export class ArchDiagramStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Create VPC
    const vpc = new ec2.Vpc(this, 'MyVPC', {
      maxAzs: 2,
      natGateways: 1
    });

    // 2. Create EC2 Instance
    const ec2Instance = new ec2.Instance(this, 'WebServer', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      securityGroup: new ec2.SecurityGroup(this, 'WebServerSG', {
        vpc,
        allowAllOutbound: true
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2
      })
    });

    // 3. Create ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true
    });

    // Create ALB listener
    const listener = alb.addListener('Listener', {
      port: 80,
      open: true
    });

    // Add EC2 instance to target group
    listener.addTargets('WebTarget', {
      port: 80,
      targets: [new targets.InstanceTarget(ec2Instance)],
      healthCheck: {
        path: '/',
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(10)
      }
    });

    // 4. Create CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100
    });

    // 5. Allow CloudFront IPs to access ALB
    const albSg = alb.connections.securityGroups[0];
    albSg.addIngressRule(
      ec2.Peer.ipv4('0.0.0.0/0'),
      ec2.Port.tcp(80),
      'Allow CloudFront access'
    );

    // Output the CloudFront URL
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName
    });
  }
}
