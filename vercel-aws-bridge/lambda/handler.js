exports.handler = async (event) => {
  console.log('Received from Vercel cron:', event);
  // Add your business logic here
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Lambda executed successfully' }),
  };
};
