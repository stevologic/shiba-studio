// Quick local test (requires AWS creds)
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

(async () => {
  const client = new LambdaClient({ region: 'us-east-1' });
  const cmd = new InvokeCommand({
    FunctionName: process.env.LAMBDA_FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify({ test: true })),
  });
  const res = await client.send(cmd);
  console.log(res);
})();
