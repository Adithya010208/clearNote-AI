const https = require('https');

async function getStatus() {
  const getJson = (url) => new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node.js' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  try {
    const runs = await getJson('https://api.github.com/repos/Adithya010208/clearNote-AI/actions/runs');
    console.log('Latest Run Status:', runs.workflow_runs[0].status, 'Conclusion:', runs.workflow_runs[0].conclusion);
  } catch (err) {
    console.error(err);
  }
}

getStatus();
