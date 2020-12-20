'use strict';

// Use AWS SDK instead of inviking command line
const spawnSync = require('child_process').spawnSync;
const AWS = require('aws-sdk');
const path = require('path');
const s3 = AWS.S3;

const { resolve } = require('path');
const { readdir, readFile } = require('fs').promises;


//node 11+
async function* getFiles(dir) {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const res = resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* getFiles(res);
    } else {
      yield res;
    }
  }
}

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.commands = {
      syncToS3: {
        usage: 'Deploys the `app` directory to your bucket',
        lifecycleEvents: [
          'sync',
        ],
      },
      domainInfo: {
        usage: 'Fetches and prints out the deployed CloudFront domain names',
        lifecycleEvents: [
          'domainInfo',
        ],
      },
      invalidateCloudFrontCache: {
        usage: 'Invalidates CloudFront cache',
        lifecycleEvents: [
          'invalidateCache',
        ],
      },
    };

    this.hooks = {
      'syncToS3:sync': this.syncDirectory.bind(this),
      'domainInfo:domainInfo': this.domainInfo.bind(this),
      'invalidateCloudFrontCache:invalidateCache': this.invalidateCache
      .bind(
        this,
      ),
    };
  }

  runAwsCommand(args) {
    let command = 'aws';
    if (this.serverless.variables.service.provider.region) {
      command =
        `${command} --region ${this.serverless.variables.service.provider.region}`;
    }
    if (this.serverless.variables.service.provider.profile) {
      command =
        `${command} --profile ${this.serverless.variables.service.provider.profile}`;
    }
    const result = spawnSync(command, args);
    const stdout = result.stdout.toString();
    const sterr = result.stderr.toString();
    if (stdout) {
      this.serverless.cli.log(stdout);
    }
    if (sterr) {
      this.serverless.cli.log(sterr);
    }

    return {
      stdout,
      sterr
    };
  }

  // syncs the `app` directory to the provided bucket
  async syncDirectory() {
    const s3BucketName = this.serverless.variables.service.custom.s3Bucket;
    const directoryPath = this.serverless.variables.service.custom
      .appDirectory;

    const s3Bucket = new s3({
      params: {
        Bucket: s3BucketName
      }
    });
    // walk appDirectory
    for await (const f of getFiles(directoryPath)) {
      console.log(f);
      let content = await readFile(f, 'binary');
      await s3Bucket.putObject({
        Key: path.relative(directoryPath,f),
        Body: content,
      }).promise();
    }
    this.serverless.cli.log('Successfully synced to the S3 bucket');
  }

  // fetches the domain name from the CloudFront outputs and prints it out
  async domainInfo() {
    const provider = this.serverless.getProvider('aws');
    const stackName = provider.naming.getStackName(this.options.stage);
    const result = await provider.request(
      'CloudFormation',
      'describeStacks', {
        StackName: stackName
      },
      this.options.stage,
      this.options.region,
    );

    const outputs = result.Stacks[0].Outputs;
    const output = outputs.find(
      entry => entry.OutputKey === 'WebAppCloudFrontDistributionOutput',
    );

    if (output && output.OutputValue) {
      this.serverless.cli.log(`Web App Domain: ${output.OutputValue}`);
      return output.OutputValue;
    }

    this.serverless.cli.log('Web App Domain: Not Found');
    const error = new Error('Could not extract Web App Domain');
    throw error;
  }

  async invalidateCache() {
    const provider = this.serverless.getProvider('aws');

    const domain = await this.domainInfo();

    const result = await provider.request(
      'CloudFront',
      'listDistributions', {},
      this.options.stage,
      this.options.region,
    );

    const distributions = result.DistributionList.Items;
    const distribution = distributions.find(
      entry => entry.DomainName === domain,
    );

    if (distribution) {
      this.serverless.cli.log(
        `Invalidating CloudFront distribution with id: ${distribution.Id}`,
      );
      const args = [
        'cloudfront',
        'create-invalidation',
        '--distribution-id',
        distribution.Id,
        '--paths',
        '/*',
      ];
      const {
        sterr
      } = this.runAwsCommand(args);
      if (!sterr) {
        this.serverless.cli.log('Successfully invalidated CloudFront cache');
      } else {
        throw new Error('Failed invalidating CloudFront cache');
      }
    } else {
      const message = `Could not find distribution with domain ${domain}`;
      const error = new Error(message);
      this.serverless.cli.log(message);
      throw error;
    }
  }
}

module.exports = ServerlessPlugin;
