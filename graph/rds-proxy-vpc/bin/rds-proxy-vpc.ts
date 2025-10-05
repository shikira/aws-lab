#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsProxyVpcStack } from '../lib/rds-proxy-vpc-stack';
import { CdkGraph } from "@aws/pdk/cdk-graph";
import { PDKNagApp } from "@aws/pdk/pdk-nag";
import { CdkGraphDiagramPlugin } from '@aws/pdk/cdk-graph-plugin-diagram';
import { CdkGraphThreatComposerPlugin } from '@aws/pdk/cdk-graph-plugin-threat-composer';

(async () => {

  const app = new PDKNagApp();
  new RdsProxyVpcStack(app, 'RdsProxyVpcStack', {
    /* If you don't specify 'env', this stack will be environment-agnostic.
    * Account/Region-dependent features and context lookups will not work,
    * but a single synthesized template can be deployed anywhere. */

    /* Uncomment the next line to specialize this stack for the AWS Account
    * and Region that are implied by the current CLI configuration. */
    // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

    /* Uncomment the next line if you know exactly what Account and Region you
    * want to deploy the stack to. */
    // env: { account: '123456789012', region: 'us-east-1' },

    /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
  });
  const graph = new CdkGraph(app, {
      plugins: [
        new CdkGraphDiagramPlugin(),
        new CdkGraphThreatComposerPlugin({
          applicationDetails: {
            name: "My Application"
          },
        })
      ],
    });
  app.synth();

  // async cdk-graph reporting hook
  await graph.report();
})();