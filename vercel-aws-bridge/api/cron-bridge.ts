import type { VercelRequest, VercelResponse } from '@vercel/node';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({ region: process.env.AWS_REGION });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel Cron protection
  if (req.headers.authorization !== `Bearer ${process.env.VERCEL_CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = {
    source: 'vercel-cron',
    timestamp: new Date().toISOString(),
    data: req.body || {},
  };

  try {
    const command = new InvokeCommand({
      FunctionName: process.env.LAMBDA_FUNCTION_NAME!,
      Payload: Buffer.from(JSON.stringify(payload)),
    });

    const result = await lambda.send(command);
    res.status(200).json({
      success: true,
      lambdaStatus: result.StatusCode,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
