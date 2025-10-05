import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export class RdsProxyVpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC-A (10.0.0.0/16) - Client VPC
    const vpcA = new ec2.Vpc(this, 'VPC-A', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PrivateSubnetA',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 24,
          name: 'PrivateSubnetB',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
      flowLogs: {
        'FlowLogA': {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(),
        }
      },
    });

    // VPC-B (10.1.0.0/16) - Database VPC
    const vpcB = new ec2.Vpc(this, 'VPC-B', {
      ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PrivateSubnetC',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 24,
          name: 'PrivateSubnetD',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
      flowLogs: {
        'FlowLogB': {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(),
        }
      },
    });

    // VPC Peering Connection (conditional)
    const enablePeering = this.node.tryGetContext('enablePeering') === 'true';
    let peeringConnection: ec2.CfnVPCPeeringConnection | undefined;

    if (enablePeering) {
      peeringConnection = new ec2.CfnVPCPeeringConnection(this, 'VPCPeeringConnection', {
        vpcId: vpcA.vpcId,
        peerVpcId: vpcB.vpcId,
        tags: [{ key: 'Name', value: 'VPC-A-to-VPC-B-Peering' }],
      });

      // Add routes for peering connection
      vpcA.isolatedSubnets.forEach((subnet, index) => {
        new ec2.CfnRoute(this, `RouteA${index}`, {
          routeTableId: subnet.routeTable.routeTableId,
          destinationCidrBlock: '10.1.0.0/16',
          vpcPeeringConnectionId: peeringConnection!.ref,
        });
      });

      vpcB.isolatedSubnets.forEach((subnet, index) => {
        new ec2.CfnRoute(this, `RouteB${index}`, {
          routeTableId: subnet.routeTable.routeTableId,
          destinationCidrBlock: '10.0.0.0/16',
          vpcPeeringConnectionId: peeringConnection!.ref,
        });
      });
    }

    // Security Groups
    const clientSecurityGroup = new ec2.SecurityGroup(this, 'ClientSecurityGroup', {
      vpc: vpcA,
      description: 'Security group for EC2 client',
      allowAllOutbound: true,
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: vpcB,
      description: 'Security group for RDS Aurora',
      allowAllOutbound: false,
    });

    const proxySecurityGroup = new ec2.SecurityGroup(this, 'ProxySecurityGroup', {
      vpc: vpcB,
      description: 'Security group for RDS Proxy',
      allowAllOutbound: true,
    });

    // Database subnet group
    const dbSubnetGroup = new rds.SubnetGroup(this, 'DatabaseSubnetGroup', {
      vpc: vpcB,
      description: 'Subnet group for Aurora cluster',
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    // KMS Key for encryption
    const kmsKey = new kms.Key(this, 'DatabaseKey', {
      description: 'KMS key for database encryption',
      enableKeyRotation: true,
    });

    // Database credentials
    const dbCredentials = new secretsmanager.Secret(this, 'DatabaseCredentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
      },
      encryptionKey: kmsKey,
    });

    // Aurora cluster
    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_4,
      }),
      writer: rds.ClusterInstance.provisioned('writer', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      }),
      readers: [
        rds.ClusterInstance.provisioned('reader', {
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
        }),
      ],
      credentials: rds.Credentials.fromSecret(dbCredentials),
      vpc: vpcB,
      subnetGroup: dbSubnetGroup,
      securityGroups: [dbSecurityGroup],
      defaultDatabaseName: 'testdb',
      storageEncrypted: true,
      storageEncryptionKey: kmsKey,
      iamAuthentication: true,
      deletionProtection: true,
    });

    // RDS Proxy Role
    const proxyRole = new iam.Role(this, 'ProxyRole', {
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
      inlinePolicies: {
        GetSecretValuePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
              ],
              resources: [dbCredentials.secretArn],
            }),
          ],
        }),
      },
    });

    // RDS Proxy
    const proxy = new rds.DatabaseProxy(this, 'RDSProxy', {
      proxyTarget: rds.ProxyTarget.fromCluster(cluster),
      secrets: [dbCredentials],
      vpc: vpcB,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [proxySecurityGroup],
      role: proxyRole,
    });

    // Security group rules
    if (enablePeering) {
      proxySecurityGroup.addIngressRule(
        ec2.Peer.ipv4('10.0.0.0/16'),
        ec2.Port.tcp(5432),
        'Allow PostgreSQL from VPC-A'
      );
    }

    dbSecurityGroup.addIngressRule(
      proxySecurityGroup,
      ec2.Port.tcp(5432),
      'Allow from RDS Proxy'
    );

    // EC2 Instance in VPC-A
    const ec2Instance = new ec2.Instance(this, 'ClientInstance', {
      vpc: vpcA,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: clientSecurityGroup,
      userData: ec2.UserData.forLinux(),
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(8, {
          encrypted: true,
          kmsKey: kmsKey,
        }),
      }],
      detailedMonitoring: true,
    });
    
    // Enable termination protection
    const cfnInstance = ec2Instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.disableApiTermination = true;

    // Install PostgreSQL client
    ec2Instance.userData.addCommands(
      'yum update -y',
      'yum install -y postgresql15'
    );

    // Outputs
    new cdk.CfnOutput(this, 'VPC-A-ID', { value: vpcA.vpcId });
    new cdk.CfnOutput(this, 'VPC-B-ID', { value: vpcB.vpcId });
    new cdk.CfnOutput(this, 'ClientInstanceId', { value: ec2Instance.instanceId });
    new cdk.CfnOutput(this, 'ClusterEndpoint', { value: cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'ProxyEndpoint', { value: proxy.endpoint });
    
    if (enablePeering) {
      new cdk.CfnOutput(this, 'PeeringConnectionId', { 
        value: peeringConnection!.ref 
      });
    }

    new cdk.CfnOutput(this, 'DatabaseSecretArn', { value: dbCredentials.secretArn });

    // Add automatic rotation to the secret using hosted rotation
    dbCredentials.addRotationSchedule('DatabaseCredentialsRotation', {
      hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
        vpc: vpcB,
      }),
      automaticallyAfter: cdk.Duration.days(30),
    });
  }
}
