import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ManagedLoginStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const URL = 'https://aws.amazon.com'

    // create cognito user pool
    const userPool = new cdk.aws_cognito.UserPool(this, 'ManagedLoginUserPool', {
      userPoolName: 'managed-login-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
        }
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    const userPoolClient = new cdk.aws_cognito.UserPoolClient(this, 'ManagedLoginUserPoolClient', {
      userPool: userPool,
      userPoolClientName: 'managed-login-user-pool-client',
      generateSecret: true,
      oAuth: {
        callbackUrls: [URL],
        logoutUrls: [URL],
        scopes: [
          cdk.aws_cognito.OAuthScope.OPENID
        ],
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false
        }
      },
      supportedIdentityProviders: [
        cdk.aws_cognito.UserPoolClientIdentityProvider.COGNITO
      ],
      preventUserExistenceErrors: true,
    })

    // まだmanaged loginは未対応なので、cfnで実装する
    // userPool.addDomain('ManagedLoginUserPoolDomain', {
    //   cognitoDomain: {
    //     domainPrefix: `managed-login-domain-${process.env.CDK_DEFAULT_ACCOUNT}`
    //   }
    // })

    // create cognito user pool domain with managed login
    const cfnUserPoolDomain = new cdk.aws_cognito.CfnUserPoolDomain(this, 'ManagedLoginUserPoolDomain', {
      domain: `managed-login-domain-${process.env.CDK_DEFAULT_ACCOUNT}`,
      userPoolId: userPool.userPoolId,
      managedLoginVersion: 2,
    });

    new cdk.aws_cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true
    })

    // output
    new cdk.CfnOutput(this, 'ManagedLoginUrl', {
      value: `https://${cfnUserPoolDomain.domain}.auth.${process.env.CDK_DEFAULT_REGION}.amazoncognito.com/login?lang=ja&response_type=code&client_id=${userPoolClient.userPoolClientId}&redirect_uri=${URL}`
    })
  }
}
