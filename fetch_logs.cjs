const https = require('https');

async function getFailedStepLogs() {
  const repo = 'Adithya010208/clearNote-AI';
  
  const getJson = (url) => new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node.js' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  try {
    const runs = await getJson(`https://api.github.com/repos/${repo}/actions/runs`);
    const runId = runs.workflow_runs[0].id;
    const jobsData = await getJson(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`);
    
    const job = jobsData.jobs[0];
    const failedSteps = job.steps.filter(s => s.conclusion === 'failure');
    failedSteps.forEach(s => console.log('Failed step:', s.name));
  } catch (err) {
    console.error(err);
  }
}
getFailedStepLogs();
