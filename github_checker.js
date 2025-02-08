require("dotenv").config();
const axios = require("axios");
const https = require("https");
const fs = require("fs");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SEART_API_URL = "https://seart-ghs.si.usi.ch/api/r/search";
const GITHUB_API_URL = "https://api.github.com/repos/";

const GITHUB_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "GitHub-Repo-Checker",
};

const seartSearchParams = {
  name: "",
  nameEquals: false,
  language: "JavaScript",
  committedMin: "2024-02-03",
  committedMax: "2025-02-03",
  starsMin: 50,
  sort: "name,asc",
  page: 0,
};

// Fetch repositories from SEART API and save them
async function fetchRepositories() {
  try {
    console.log("fetching SEART repos...");
    let repositories = [];

    for (let page = 0; page < 30; page++) {
      console.log(`Fetching page ${page + 1}...`);
      const response = await axios.get(SEART_API_URL, {
        params: { ...seartSearchParams, page, size: 100 },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });

      if (response.data.items.length === 0) break;
      repositories.push(...response.data.items);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`repositories fetched: ${repositories.length}`);
    fs.writeFileSync("seart_repos.json", JSON.stringify(repositories, null, 2));
    return repositories;
  } catch (error) {
    console.error(`SEART API Error: ${error.response?.status || error.message}`);
    return [];
  }
}

// Check remaining GitHub API rate limit
async function checkRateLimit() {
  const url = "https://api.github.com/rate_limit";
  const response = await axios.get(url, { headers: GITHUB_HEADERS });
  return response.data.rate.remaining;
}

// Pause execution if API limit is low
async function waitIfNeeded() {
  const remaining = await checkRateLimit();
  console.log(`Rate limit remaining: ${remaining}`);
  if (remaining < 100) {
    console.log(`Approaching rate limit. Pausing for 1 hour...`);
    await new Promise(resolve => setTimeout(resolve, 3600000));
  }
}

// Check if repo has CI/CD and package.json
async function checkRepoContents(repo) {
  try {
    const repoContentsUrl = `${GITHUB_API_URL}${repo}/contents/`;
    const response = await axios.get(repoContentsUrl, { headers: GITHUB_HEADERS });

    const files = response.data.map(file => file.name);
    const hasPackageJson = files.includes("package.json");

    const ciFiles = [".travis.yml", ".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", "appveyor.yml", "bitrise.yml", "wercker.yml"];
    const hasOtherCiCd = files.some(file => ciFiles.includes(file));

    let hasGha = false;
    if (files.includes(".github")) {
      const workflowsUrl = `${GITHUB_API_URL}${repo}/contents/.github/workflows/`;
      try {
        const workflowsResponse = await axios.get(workflowsUrl, { headers: GITHUB_HEADERS });
        hasGha = workflowsResponse.data.some(file => file.name.endsWith(".yml"));
      } catch (error) {
        if (error.response?.status !== 404) {
          console.error(`⚠️ Error checking GitHub Actions for ${repo}: ${error.message}`);
        }
      }
    }

    return { hasCi: hasGha || hasOtherCiCd, hasGha, hasOtherCiCd, hasPackageJson };
  } catch (error) {
    if (error.response?.status !== 404) {
      console.error(`⚠️ Error checking repo ${repo}: ${error.message}`);
    }
    return { hasCi: false, hasGha: false, hasOtherCiCd: false, hasPackageJson: false };
  }
}

// Process repositories sequentially to avoid rate limits
async function checkRepositories() {
  if (!fs.existsSync("seart_repos.json")) {
    console.log("⚠️ No saved repository data found. Fetching from SEART API...");
    await fetchRepositories();
  }

  const repositories = JSON.parse(fs.readFileSync("seart_repos.json"));
  if (!repositories.length) {
    console.log("⚠️ No repositories found.");
    return [];
  }

  console.log(`🔍 Found ${repositories.length} repositories. Checking sequentially...`);
  const validRepos = [];

  for (let i = 0; i < repositories.length; i++) {
    const repo = repositories[i];
    console.log(`📌 Processing ${i + 1}/${repositories.length}: ${repo.name}`);

    await waitIfNeeded();
    try {
      const { hasCi, hasPackageJson, hasGha, hasOtherCiCd } = await checkRepoContents(repo.name);

      if (hasCi && hasPackageJson) {
        validRepos.push({
          id: repo.id,
          name: repo.name,
          url: `https://github.com/${repo.name}`,
          description: repo.description || "No description",
          stars: repo.stargazers,
          forks: repo.forks,
          watchers: repo.watchers,
          open_issues: repo.openIssues,
          total_issues: repo.totalIssues,
          language: repo.mainLanguage,
          topics: repo.topics,
          license: repo.license || "None",
          created_at: repo.createdAt,
          updated_at: repo.updatedAt,
          last_commit: repo.lastCommit,
          default_branch: repo.defaultBranch,
          hasCi,
          hasGha,
          hasOtherCiCd,
          hasPackageJson
        });
      }
    } catch (error) {
      console.error(`⚠️ Error processing ${repo.name}: ${error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log("\n✅ Final List of Valid Repositories:", validRepos);
  fs.writeFileSync("results.json", JSON.stringify(validRepos, null, 2));
  console.log("💾 Results saved.");
  return validRepos;
}

// Count number of valid repositories in results file
function countValidRepositories() {
  const resultsFile = "results.json";
  if (!fs.existsSync(resultsFile)) {
    console.log("⚠️ No results file found.");
    return;
  }

  const data = JSON.parse(fs.readFileSync(resultsFile));
  console.log(`📊 Total Valid Repositories Found: ${data.length}`);
}

// Run the script
checkRepositories().then(() => countValidRepositories());
