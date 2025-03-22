import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import { Construct } from 'constructs';

export class FtpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Create IAM Role for EC2
    const ec2Role = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')
    });
   
    // 2. Create Secret in Secrets Manager
    const ftpSecret = new secretsmanager.Secret(this, 'FTPUserSecret', {
      secretName: 'ftp/user/credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'ftp-user' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 16
      },
      description: 'FTP user credentials',
    });
    ftpSecret.grantRead(ec2Role);

    // 3. Create VPC
    const vpc = new ec2.Vpc(this, 'MyVPC', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        }
      ]
    });

    // 4. Create Security Group for EC2 instances
    const ec2SecurityGroup = new ec2.SecurityGroup(this, 'FtpSecurityGroup', {
      vpc,
      description: 'Security group for FTP server',
      allowAllOutbound: true,
    });
    ec2SecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(21),
      'Allow HTTP traffic'
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'dnf update -y',
      'dnf install -y vsftpd',

      // Get secret from Secrets Manager
      `secret=$(aws secretsmanager get-secret-value --secret-id ${ftpSecret.secretName} --region ${this.region} --query SecretString --output text)`,
      'username=$(echo $secret | jq -r .username)',
      'password=$(echo $secret | jq -r .password)',

      // Create FTP user
      'useradd $username',
      'echo "$password" | passwd --stdin $username',

      // Create FTP directory
      'mkdir -p /home/$username',
      'chown $username:$username /home/$username',

      // Configure vsftpd
      'cp /etc/vsftpd/vsftpd.conf /etc/vsftpd/vsftpd.conf.bak',
      'echo "anonymous_enable=NO" >> /etc/vsftpd/vsftpd.conf',
      //'echo "local_enable=YES" >> /etc/vsftpd/vsftpd.conf',
      //'echo "write_enable=YES" >> /etc/vsftpd/vsftpd.conf',
      'echo "chroot_local_user=YES" >> /etc/vsftpd/vsftpd.conf',
      'echo "allow_writeable_chroot=YES" >> /etc/vsftpd/vsftpd.conf',
      'echo "pasv_enable=NO" >> /etc/vsftpd/vsftpd.conf',

      // Start and enable vsftpd service
      'systemctl start vsftpd',
      'systemctl enable vsftpd'
    );


    // 5. Create Auto Scaling Group with EC2 instances
    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
        cpuType: ec2.AmazonLinuxCpuType.X86_64
      }),
      minCapacity: 2,
      maxCapacity: 4,
      desiredCapacity: 2,
      securityGroup: ec2SecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      userData: userData,
    });
    asg.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [ftpSecret.secretArn]
    }));

    // 6. Create Network Load Balancer
    const nlb = new elb.NetworkLoadBalancer(this, 'MyNLB', {
      vpc,
      crossZoneEnabled: true, // Enable cross-zone load balancing
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    // 7. Create Target Group
    const targetGroup = new elb.NetworkTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 21,
      protocol: elb.Protocol.TCP,
      targetType: elb.TargetType.INSTANCE,
      healthCheck: {
        enabled: true,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        interval: cdk.Duration.seconds(30),
      },
    });
    // https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-target-groups.html
    targetGroup.setAttribute('stickiness.enabled', 'true');
    targetGroup.setAttribute('stickiness.type', 'source_ip');
    targetGroup.addTarget(asg);

    // 8. Add Listener and Target Group
    const listener = nlb.addListener('TCPListener', {
      port: 21,
      protocol: elb.Protocol.TCP,
    });
    listener.addTargetGroups('WebFleet',targetGroup);

    // 9. Output the NLB DNS name
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: nlb.loadBalancerDnsName,
    });
  }
}