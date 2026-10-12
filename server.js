const express = require('express');
const { Octokit } = require('@octokit/rest');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO || 'nexusai-build-runner';

const CODEMAGIC_API_TOKEN = process.env.CODEMAGIC_API_TOKEN;
const CODEMAGIC_APP_ID = process.env.CODEMAGIC_APP_ID;

if (!GITHUB_TOKEN || !GITHUB_OWNER) {
  console.error('⚠️  Missing GITHUB_TOKEN or GITHUB_OWNER');
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ============ HEALTH CHECK ============
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'NexusAI Build Server',
    version: '2.4.0',
    defaultFramework: 'react-native',
    frameworks: ['react-native', 'flutter', 'kotlin', 'java'],
    features: [
      'dynamic-packages',
      'multi-framework',
      'release-download',
      'codemagic-integration'
    ],
    codemagic: {
      configured: !!(CODEMAGIC_API_TOKEN && CODEMAGIC_APP_ID),
      hasToken: !!CODEMAGIC_API_TOKEN,
      hasAppId: !!CODEMAGIC_APP_ID
    },
    github: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    timestamp: new Date().toISOString()
  });
});

// ============ BUILD VIA GITHUB ACTIONS ============
app.post('/api/build', async (req, res) => {
  try {
    const { code, appName = 'MyApp', framework = 'react-native', packages = [] } = req.body;
    
    const validFrameworks = ['react-native', 'flutter', 'kotlin', 'java'];
    if (!validFrameworks.includes(framework)) {
      return res.status(400).json({
        success: false,
        error: `Invalid framework. Use: ${validFrameworks.join(', ')}`
      });
    }
    
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
    
    const packagesList = Array.isArray(packages) ? packages.join('\n') : '';
    const packagesBase64 = Buffer.from(packagesList).toString('base64');
    
    console.log(`[GitHub] ${framework}: ${safeAppName}, ${code.length} bytes, ${packages.length} packages`);
    
    await octokit.actions.createWorkflowDispatch({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      workflow_id: 'build.yml',
      ref: 'main',
      inputs: {
        build_id: buildId,
        user_code: codeBase64,
        app_name: safeAppName,
        framework: framework,
        packages: packagesBase64
      }
    });
    
    res.json({
      success: true,
      buildId,
      appName: safeAppName,
      framework,
      packagesCount: packages.length,
      buildSystem: 'github-actions',
      message: `${framework} build started on GitHub Actions`,
      statusUrl: `/api/build/${buildId}/status`
    });
    
  } catch (err) {
    console.error('[GitHub] Build error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ BUILD VIA CODEMAGIC ============
app.post('/api/build-codemagic', async (req, res) => {
  try {
    const { code, appName = 'MyApp', framework = 'react-native', packages = [] } = req.body;
    
    if (!CODEMAGIC_API_TOKEN || !CODEMAGIC_APP_ID) {
      return res.status(500).json({ 
        success: false,
        error: 'Codemagic not configured. Set CODEMAGIC_API_TOKEN and CODEMAGIC_APP_ID env vars.' 
      });
    }
    
    const validFrameworks = ['react-native', 'flutter', 'kotlin', 'java'];
    if (!validFrameworks.includes(framework)) {
      return res.status(400).json({
        success: false,
        error: `Invalid framework. Use: ${validFrameworks.join(', ')}`
      });
    }
    
    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Code is required (string)'
      });
    }
    
    const buildId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const codeBase64 = Buffer.from(code).toString('base64');
    const packagesBase64 = Buffer.from(JSON.stringify(packages)).toString('base64');
    const safeAppName = appName.replace(/[^a-zA-Z0-9]/g, '') || 'MyApp';
    
    const workflowId = framework === 'flutter' ? 'flutter-workflow' : 'rn-workflow';
    
    console.log(`[Codemagic] ${framework}: ${safeAppName}, ${code.length} bytes, ${packages.length} packages`);
    console.log(`[Codemagic] Workflow: ${workflowId}`);
    
    const response = await fetch(`https://api.codemagic.io/builds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': CODEMAGIC_API_TOKEN
      },
      body: JSON.stringify({
        appId: CODEMAGIC_APP_ID,
        workflowId: workflowId,
        branch: 'main',
        environment: {
          variables: {
            USER_CODE: codeBase64,
            APP_NAME: safeAppName,
            PACKAGES: packagesBase64
          }
        }
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      console.error('[Codemagic] API Error:', data.error);
      return res.status(400).json({ 
        success: false, 
        error: typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
      });
    }
    
    console.log(`[Codemagic] Build started: ${data.buildId}`);
    
    res.json({
      success: true,
      buildId: data.buildId,
      codemagicId: data.buildId,
      appName: safeAppName,
      framework,
      packagesCount: packages.length,
      buildSystem: 'codemagic',
      message: `Codemagic ${framework} build started`,
      statusUrl: `/api/codemagic/${data.buildId}/status`
    });
    
  } catch (err) {
    console.error('[Codemagic] Exception:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ GITHUB BUILD STATUS ============
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
        const release = await octokit.repos.getReleaseByTag({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          tag: `build-${buildId}`
        });
        const apkAsset = release.data.assets.find(a => a.name.endsWith('.apk'));
        if (apkAsset) {
          downloadUrl = apkAsset.browser_download_url;
        }
      } catch (e) {
        console.log('Release not found:', e.message);
      }
      
      try {
        const artifacts = await octokit.actions.listWorkflowRunArtifacts({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          run_id: run.id
        });
        
        if (artifacts.data.artifacts.length > 0) {
          artifactName = artifacts.data.artifacts[0].name;
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
      buildSystem: 'github-actions',
      startedAt: run.created_at,
      updatedAt: run.updated_at
    });
    
  } catch (err) {
    console.error('Status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ CODEMAGIC BUILD STATUS ============
app.get('/api/codemagic/:buildId/status', async (req, res) => {
  try {
    const { buildId } = req.params;
    
    if (!CODEMAGIC_API_TOKEN) {
      return res.status(500).json({ 
        error: 'Codemagic not configured' 
      });
    }
    
    const response = await fetch(`https://api.codemagic.io/builds/${buildId}`, {
      headers: { 'x-auth-token': CODEMAGIC_API_TOKEN }
    });
    
    const data = await response.json();
    const build = data.build || data;
    
    if (build.error) {
      return res.status(400).json({ error: build.error });
    }
    
    let status = 'building';
    let progress = 50;
    
    if (build.status === 'finished') {
      status = 'success';
      progress = 100;
    } else if (build.status === 'failed' || build.status === 'canceled') {
      status = 'failed';
      progress = 0;
    } else if (build.status === 'queued') {
      status = 'queued';
      progress = 10;
    } else if (build.status === 'building' || build.status === 'preparing') {
      status = 'building';
      progress = 50;
    }
    
    let downloadUrl = null;
    if (status === 'success' && build.artifacts && build.artifacts.length > 0) {
      const apkArtifact = build.artifacts.find(a => 
        a.name && a.name.endsWith('.apk')
      );
      if (apkArtifact) {
        downloadUrl = apkArtifact.url;
      }
    }
    
    res.json({
      status,
      buildId,
      progress,
      downloadUrl,
      buildUrl: build.buildUrl,
      buildSystem: 'codemagic',
      startedAt: build.startedAt,
      finishedAt: build.finishedAt
    });
    
  } catch (err) {
    console.error('[Codemagic Status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ CODEMAGIC HEALTH CHECK ============
app.get('/api/codemagic-status', async (req, res) => {
  if (!CODEMAGIC_API_TOKEN || !CODEMAGIC_APP_ID) {
    return res.json({ 
      configured: false,
      message: 'Set CODEMAGIC_API_TOKEN and CODEMAGIC_APP_ID env vars',
      hasToken: !!CODEMAGIC_API_TOKEN,
      hasAppId: !!CODEMAGIC_APP_ID
    });
  }
  
  try {
    const response = await fetch(`https://api.codemagic.io/apps/${CODEMAGIC_APP_ID}`, {
      headers: { 'x-auth-token': CODEMAGIC_API_TOKEN }
    });
    const data = await response.json();
    
    res.json({
      configured: true,
      appName: data.app?.appName || 'NexusAI',
      appId: CODEMAGIC_APP_ID,
      status: 'online',
      availableWorkflows: ['flutter-workflow', 'rn-workflow']
    });
  } catch (err) {
    res.json({ 
      configured: true, 
      error: err.message,
      appId: CODEMAGIC_APP_ID
    });
  }
});

// ============ LIST BUILDS ============
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
      runUrl: r.html_url,
      buildSystem: 'github-actions'
    }));
    
    res.json({ builds });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ LIST FRAMEWORKS ============
app.get('/api/frameworks', (req, res) => {
  res.json({
    default: 'react-native',
    frameworks: [
      { 
        id: 'react-native', 
        name: 'React Native', 
        language: 'TypeScript', 
        status: 'stable', 
        supportsPackages: true,
        recommended: true
      },
      { 
        id: 'flutter', 
        name: 'Flutter', 
        language: 'Dart', 
        status: 'stable', 
        supportsPackages: true,
        recommended: false
      },
      { 
        id: 'kotlin', 
        name: 'Kotlin', 
        language: 'Kotlin', 
        status: 'stable', 
        supportsPackages: false,
        recommended: false
      },
      { 
        id: 'java', 
        name: 'Java', 
        language: 'Java', 
        status: 'stable', 
        supportsPackages: false,
        recommended: false
      }
    ]
  });
});

// ============ GET RELEASE INFO ============
app.get('/api/build/:buildId/release', async (req, res) => {
  try {
    const { buildId } = req.params;
    const tagName = `build-${buildId}`;
    
    const release = await octokit.repos.getReleaseByTag({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      tag: tagName
    });
    
    const assets = release.data.assets.map(a => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url
    }));
    
    res.json({
      success: true,
      tag: release.data.tag_name,
      name: release.data.name,
      publishedAt: release.data.published_at,
      assets,
      apkUrl: assets.find(a => a.name.endsWith('.apk'))?.downloadUrl || null
    });
    
  } catch (err) {
    res.status(404).json({ 
      success: false, 
      error: 'Release not found: ' + err.message 
    });
  }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 NexusAI Build Server v2.4`);
  console.log(`   Port: ${PORT}`);
  console.log(`   GitHub: ${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`   Default Framework: react-native`);
  console.log(`   Codemagic: ${CODEMAGIC_API_TOKEN && CODEMAGIC_APP_ID ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`   Features: dynamic-packages, multi-framework, codemagic`);
});
