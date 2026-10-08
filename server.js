const express = require('express');
const { Octokit } = require('@octokit/rest');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO || 'nexusai-build-runner';

if (!GITHUB_TOKEN || !GITHUB_OWNER) {
  console.error('⚠️  Missing GITHUB_TOKEN or GITHUB_OWNER');
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'NexusAI Build Server',
    version: '1.0.0',
    github: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    timestamp: new Date().toISOString()
  });
});

// Start build
app.post('/api/build', async (req, res) => {
  try {
    const { code, appName = 'MyApp' } = req.body;
    
    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Code is required (string)'
      });
    }
    
    if (code.length > 500000) {
      return res.status(400).json({
        success: false,
        error: 'Code too large (max 500KB)'
      });
    }
    
    const buildId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const codeBase64 = Buffer.from(code).toString('base64');
    const safeAppName = appName.replace(/[^a-zA-Z0-9]/g, '') || 'MyApp';
    
    console.log(`[${buildId}] Build: ${safeAppName}, ${code.length} bytes`);
    
    await octokit.actions.createWorkflowDispatch({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      workflow_id: 'build.yml',
      ref: 'main',
      inputs: {
        build_id: buildId,
        user_code: codeBase64,
        app_name: safeAppName
      }
    });
    
    res.json({
      success: true,
      buildId,
      appName: safeAppName,
      message: 'Build started',
      statusUrl: `/api/build/${buildId}/status`
    });
    
  } catch (err) {
    console.error('Build error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check status
app.get('/api/build/:buildId/status', async (req, res) => {
  try {
    const { buildId } = req.params;
    
    const runs = await octokit.actions.listWorkflowRuns({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      workflow_id: 'build.yml',
      per_page: 20
    });
    
    if (runs.data.workflow_runs.length === 0) {
      return res.json({ status: 'not_found', buildId });
    }
    
    const run = runs.data.workflow_runs[0];
    
    let status = 'building';
    let progress = 50;
    
    if (run.status === 'queued') { status = 'queued'; progress = 10; }
    else if (run.status === 'in_progress') { status = 'building'; progress = 50; }
    else if (run.status === 'completed') {
      if (run.conclusion === 'success') { status = 'success'; progress = 100; }
      else { status = 'failed'; progress = 0; }
    }
    
    let downloadUrl = null;
    let artifactName = null;
    
    if (status === 'success') {
      try {
        const artifacts = await octokit.actions.listWorkflowRunArtifacts({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          run_id: run.id
        });
        
        if (artifacts.data.artifacts.length > 0) {
          const artifact = artifacts.data.artifacts[0];
          artifactName = artifact.name;
          downloadUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${run.id}/artifacts/${artifact.id}`;
        }
      } catch (e) {
        console.error('Artifact error:', e.message);
      }
    }
    
    res.json({
      status,
      buildId,
      progress,
      downloadUrl,
      artifactName,
      runUrl: run.html_url,
      startedAt: run.created_at,
      updatedAt: run.updated_at
    });
    
  } catch (err) {
    console.error('Status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List builds
app.get('/api/builds', async (req, res) => {
  try {
    const runs = await octokit.actions.listWorkflowRuns({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      workflow_id: 'build.yml',
      per_page: 20
    });
    
    const builds = runs.data.workflow_runs.map(r => ({
      id: r.id,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      runUrl: r.html_url
    }));
    
    res.json({ builds });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 NexusAI Build Server on port ${PORT}`);
  console.log(`   GitHub: ${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`   Token: ${GITHUB_TOKEN ? '✓' : '✗'}`);
});
