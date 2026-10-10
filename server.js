const express = require('express');
const { Octokit } = require('@octokit/rest');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO || 'nexusai-build-runner';

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'NexusAI Build Server',
    version: '2.1.0',
    frameworks: ['flutter', 'react-native', 'kotlin', 'java'],
    github: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/build', async (req, res) => {
  try {
    const { code, appName = 'MyApp', framework = 'flutter' } = req.body;
    const validFrameworks = ['flutter', 'react-native', 'kotlin', 'java'];
    if (!validFrameworks.includes(framework)) {
      return res.status(400).json({ success: false, error: `Invalid framework` });
    }
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'Code is required' });
    }
    
    const buildId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const codeBase64 = Buffer.from(code).toString('base64');
    const safeAppName = appName.replace(/[^a-zA-Z0-9]/g, '') || 'MyApp';
    
    await octokit.actions.createWorkflowDispatch({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      workflow_id: 'build.yml',
      ref: 'main',
      inputs: {
        build_id: buildId,
        user_code: codeBase64,
        app_name: safeAppName,
        framework: framework
      }
    });
    
    res.json({ success: true, buildId, appName: safeAppName, framework });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/build/:buildId/status', async (req, res) => {
  try {
    const { buildId } = req.params;
    const runs = await octokit.actions.listWorkflowRuns({
      owner: GITHUB_OWNER, repo: GITHUB_REPO,
      workflow_id: 'build.yml', per_page: 20
    });
    
    if (runs.data.workflow_runs.length === 0) return res.json({ status: 'not_found' });
    
    const run = runs.data.workflow_runs[0];
    let status = 'building', progress = 50;
    
    if (run.status === 'queued') { status = 'queued'; progress = 10; }
    else if (run.status === 'in_progress') { status = 'building'; progress = 50; }
    else if (run.status === 'completed') {
      if (run.conclusion === 'success') { status = 'success'; progress = 100; }
      else { status = 'failed'; progress = 0; }
    }
    
    let downloadUrl = null;
    
    if (status === 'success') {
      try {
        // Try to get release by tag
        const release = await octokit.repos.getReleaseByTag({
          owner: GITHUB_OWNER, repo: GITHUB_REPO, tag: `build-${buildId}`
        });
        const apkAsset = release.data.assets.find(a => a.name.endsWith('.apk'));
        if (apkAsset) downloadUrl = apkAsset.browser_download_url;
      } catch (e) {
        console.log('Release not found:', e.message);
      }
    }
    
    res.json({
      status, buildId, progress, downloadUrl,
      runUrl: run.html_url,
      startedAt: run.created_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/builds', async (req, res) => {
  try {
    const runs = await octokit.actions.listWorkflowRuns({
      owner: GITHUB_OWNER, repo: GITHUB_REPO,
      workflow_id: 'build.yml', per_page: 20
    });
    res.json({ builds: runs.data.workflow_runs.map(r => ({
      id: r.id, status: r.status, conclusion: r.conclusion,
      createdAt: r.created_at, runUrl: r.html_url
    })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/frameworks', (req, res) => {
  res.json({ frameworks: [
    { id: 'flutter', name: 'Flutter', language: 'Dart', status: 'stable' },
    { id: 'react-native', name: 'React Native', language: 'TypeScript', status: 'stable' },
    { id: 'kotlin', name: 'Kotlin', language: 'Kotlin', status: 'stable' },
    { id: 'java', name: 'Java', language: 'Java', status: 'stable' }
  ]});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 NexusAI Build Server v2.1`);
  console.log(`   Port: ${PORT}`);
});
