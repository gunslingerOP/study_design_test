require("dotenv").config();
const axios = require("axios");
const https = require("https");
const fs = require("fs");

// GitHub API Token (from .env)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// API URLs
const SEART_API_URL = "https://seart-ghs.si.usi.ch/api/r/search";
const GITHUB_API_URL = "https://api.github.com/repos/";

// GitHub API Headers (Authentication)
const GITHUB_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "GitHub-Repo-Checker",
};

// SEART Search Parameters (Matching your query)
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

async function fetchRepositories() {
    try {
      console.log("🔍 Searching for up to 3000 repositories via SEART API...");
      let repositories = [];
  
      for (let page = 0; page < 30; page++) { // Fetch 3000 repos (100 per page)
        console.log(`📄 Fetching page ${page + 1}...`);
  
        const response = await axios.get(SEART_API_URL, {
          params: { ...seartSearchParams, page, size: 100 }, // Fetch 100 repos per page
          httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Bypass SSL issues
        });
  
        if (response.data.items.length === 0) break; // Stop if no more results
        repositories.push(...response.data.items);
  
        // Avoid hitting rate limits
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay between pages
      }
  
      console.log(`✅ Total repositories fetched: ${repositories.length}`);
  
      // Save repositories to a JSON file
      fs.writeFileSync("seart_repos.json", JSON.stringify(repositories, null, 2));
      console.log("💾 Repositories saved to seart_repos.json");
  
      return repositories;
    } catch (error) {
      console.error(`❌ SEART API Error: ${error.response?.status || error.message}`);
      return [];
    }
  }
  

// Check rate limits before making GitHub API calls
async function checkRateLimit() {
  const url = "https://api.github.com/rate_limit";
  const response = await axios.get(url, { headers: GITHUB_HEADERS });
  return response.data.rate.remaining;
}

async function waitIfNeeded() {
  const remaining = await checkRateLimit();
  console.log('====================================');
  console.log(`🚦 Rate limit remaining: ${remaining}`);
  console.log('====================================');
  if (remaining < 100) {
    console.log(`⚠️ Approaching rate limit (${remaining} left). Pausing for 1 hour...`);
    await new Promise(resolve => setTimeout(resolve, 3600000)); // Wait 1 hour
  }
}

async function checkRepoContents(repo) {
    try {
      // 🔹 Fetch repository contents (root directory)
      const repoContentsUrl = `${GITHUB_API_URL}${repo}/contents/`;
      const response = await axios.get(repoContentsUrl, { headers: GITHUB_HEADERS });
  
      // Extract file names from root directory
      const files = response.data.map(file => file.name);
  
      // ✅ Check for package.json in root directory
      const hasPackageJson = files.includes("package.json");
  
      // ✅ Check for other CI/CD files in root directory (Travis, Jenkins, etc.)
      const ciFiles = [
        ".travis.yml",
        ".gitlab-ci.yml",
        "Jenkinsfile",
        "azure-pipelines.yml",
        "appveyor.yml",
        "bitrise.yml",
        "wercker.yml"
      ];
      const hasOtherCiCd = files.some(file => ciFiles.includes(file));
  
      // ✅ Check for GitHub Actions (.github/workflows/*.yml)
      let hasGha = false;
      if (files.includes(".github")) {
        const workflowsUrl = `${GITHUB_API_URL}${repo}/contents/.github/workflows/`;
        try {
          const workflowsResponse = await axios.get(workflowsUrl, { headers: GITHUB_HEADERS });
  
          // Ensure at least one .yml file exists inside .github/workflows/
          hasGha = workflowsResponse.data.some(file => file.name.endsWith(".yml"));
        } catch (error) {
          if (error.response?.status !== 404) {
            console.error(`⚠️ Error checking GitHub Actions workflows for ${repo}: ${error.message}`);
          }
        }
      }
  
      // ✅ Final CI/CD check: GitHub Actions OR other CI/CD tools
      const hasCi = hasGha || hasOtherCiCd;
  
      return { hasCi, hasGha, hasOtherCiCd, hasPackageJson };
    } catch (error) {
      if (error.response?.status !== 404) {
        console.error(`⚠️ Error checking repo contents for ${repo}: ${error.message}`);
      }
      return { hasCi: false, hasGha: false, hasOtherCiCd: false, hasPackageJson: false };
    }
  }
  

// Main function to fetch & filter repositories
async function checkRepositories() {
    // 🔹 Read from saved JSON instead of calling SEART API
    if (!fs.existsSync("seart_repos.json")) {
      console.log("⚠️ No saved repository data found. Fetching from SEART API...");
      await fetchRepositories();
    }
  
    const repositories = JSON.parse(fs.readFileSync("seart_repos.json"));
    if (!repositories.length) {
      console.log("⚠️ No repositories found. Check the SEART API settings.");
      return [];
    }
  
    console.log(`🔍 Found ${repositories.length} repositories. Checking CI/CD & package.json in parallel...`);
  
    const validRepos = [];
  
    // 🔹 Process repositories in parallel
    const checks = repositories.map(async (repo, index) => {
      if (index % 10 === 0) await waitIfNeeded(); // Check rate limits every 50 repos
  
      try {
        const { hasCi, hasPackageJson, hasGha, hasOtherCiCd } = await checkRepoContents(repo.name);
  
        if (hasCi && hasPackageJson) {
          return {
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
          };
        }
      } catch (error) {
        console.error(`⚠️ Error processing ${repo.name}: ${error.message}`);
      }
      return null;
    });
  
    // 🔹 Wait for all repo checks to finish
    const results = (await Promise.all(checks)).filter(Boolean);
  
    console.log("\n✅ Final List of Valid Repositories:", results);
    fs.writeFileSync("results.json", JSON.stringify(results, null, 2));
    console.log("💾 Full metadata saved to results.json");
  
    return results;
  }
  
  

// Run the script
checkRepositories().then((validRepos) => {
  console.log("\n✅ Final List of Valid Repositories:", validRepos);
});
