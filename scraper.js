const axios = require('axios');
const cron = require('node-cron');
const { OpenAI } = require('openai');
require('dotenv').config();
const { HttpsProxyAgent } = require('https-proxy-agent');
const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const { Resend } = require('resend');

// Initialize Resend
if (!process.env.RESEND_API_KEY) {
    console.error("❌ CRITICAL: Missing Resend API Key!");
}
const resend = new Resend(process.env.RESEND_API_KEY);

// 1. Safe Supabase Init
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("❌ CRITICAL: Missing Supabase Environment Variables!");
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// 2. Safe OpenAI Init
if (!process.env.OPENAI_API_KEY) {
    console.error("❌ CRITICAL: Missing OpenAI API Key!");
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const parser = new Parser();

// 3. Safe Proxy Init (Prevents the crash!)
const PROXY_URL = process.env.PROXY_URL;
let httpsAgent = null;

if (PROXY_URL) {
    try {
        httpsAgent = new HttpsProxyAgent(PROXY_URL);
    } catch (e) {
        console.error("❌ CRITICAL: PROXY_URL is invalid. Check your DigitalOcean formatting.");
    }
} else {
    console.error("❌ CRITICAL: PROXY_URL is missing from Environment Variables!");
}

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml'
};

const processedPosts = new Set();

// Robust auto-retry wrapper for flaky proxies
async function fetchWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url, {
                httpsAgent: httpsAgent ? httpsAgent : undefined, // <-- Update this line
                headers: headers,
                timeout: 20000 
            });
            return response;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                throw new Error("404 Not Found - Subreddit does not exist or is private.");
            }

            const isLastAttempt = attempt === maxRetries;
            if (isLastAttempt) throw error;
            
            console.log(`🔄 Proxy lag on ${url}. Retrying with new IP (Attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

async function scorePostForUser(title, text, agency) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: [
                {
                    role: "system",
                    content: `You are an expert lead qualification AI. Read the Reddit post and evaluate if the user is a highly qualified lead for this business:
                    
                    Business Domain: "${agency.domain}"
                    Business Pitch/Description: "${agency.description}"
                    Competitors: ${agency.competitor1}, ${agency.competitor2}

                    Score the post from 1 to 10 based on how badly this person needs this exact business's services or if they are showing high buyer intent.
                    
                    Respond ONLY with a valid JSON object: {"score": 8}`
                },
                {
                    role: "user",
                    content: `Title: ${title}\nBody: ${text}`
                }
            ],
            temperature: 0.3, 
            response_format: { type: "json_object" } 
        });
        
        const result = JSON.parse(response.choices[0].message.content.trim());
        return parseInt(result.score) || 0;
    } catch (error) {
        console.error("AI Scoring failed:", error.message);
        return 0;
    }
}

async function scanReddit() {
    console.log('\nStarting Sublurker RSS Scanner (Proxy + Parallel Batching)...');
    
    try {
        const { data: trackers, error: trackersError } = await supabase.from('trackers').select('*');
        if (trackersError) throw new Error("Supabase Trackers Error: " + trackersError.message);
        if (!trackers || trackers.length === 0) return console.log("No active trackers found.");

        const { data: agencies, error: agenciesError } = await supabase.from('agencies').select('*');
        if (agenciesError) throw new Error("Supabase Agencies Error: " + agenciesError.message);

        const userProfiles = new Map(); 
        const now = new Date();
        
        // FILTER OUT EXPIRED USERS TO SAVE OPENAI CREDITS
        const activeAgencies = agencies.filter(agency => {
            if (agency.is_paid) return true; // Paid users always get scraped
            if (agency.trial_ends_at && new Date(agency.trial_ends_at) > now) return true; // Active trials get scraped
            return false; // Expired and unpaid? Cut them off.
        });

        activeAgencies.forEach(agency => {
            userProfiles.set(agency.id, {
                agency: agency,
                subreddits: [],
                keywords: [],
                trackerIds: {} ,
                webhookUrl: agency.webhook_url // <-- ADD THIS LINE
            });
        });

        const globalSubredditsToScrape = new Set();
        const globalKeywordsToScrape = new Set();

        trackers.forEach(t => {
            const profile = userProfiles.get(t.user_id);
            if (!profile) return;

            if (t.subreddit) {
                const cleanSub = t.subreddit.toLowerCase().replace('r/', '').trim();
                profile.subreddits.push(cleanSub);
                globalSubredditsToScrape.add(cleanSub);
                profile.trackerIds[`sub_${cleanSub}`] = t.id;
            }
            if (t.keyword) {
                const cleanKey = t.keyword.toLowerCase().trim();
                profile.keywords.push(cleanKey);
                globalKeywordsToScrape.add(cleanKey);
                profile.trackerIds[`kw_${cleanKey}`] = t.id;
            }
        });

        const chunkArray = (array, size) => {
            const chunked = [];
            for (let i = 0; i < array.length; i += size) chunked.push(array.slice(i, i + size));
            return chunked;
        };

        console.log(`Scanning ${globalSubredditsToScrape.size} unique Subreddits...`);
        const subredditBatches = chunkArray(Array.from(globalSubredditsToScrape), 2);
        
        for (const batch of subredditBatches) {
            await Promise.all(batch.map(async (sub) => {
                try {
                    const response = await fetchWithRetry(`https://www.reddit.com/r/${sub}/new.rss?limit=15`);
                    const feed = await parser.parseString(response.data);

                    for (const post of feed.items) {
                        const id = post.id || post.guid;
                        if (processedPosts.has(id)) continue;
                        
                        const created_utc = new Date(post.isoDate).getTime() / 1000;
                        const postAgeInMinutes = (Math.floor(Date.now() / 1000) - created_utc) / 60;
                        if (postAgeInMinutes > 15) continue; 

                        const title = post.title || '';
                        const selftext = post.contentSnippet || post.content || '';
                        const permalink = post.link;
                        
                        const fullTextToSearch = `${title} ${selftext}`.toLowerCase();
                        const truncatedText = selftext.length > 500 ? selftext.substring(0, 500) + '...' : selftext;

                        const usersToEvaluate = [];

                        for (const [userId, profile] of userProfiles.entries()) {
                            if (profile.subreddits.includes(sub)) {
                                
                                // --- SMART FLEXIBLE KEYWORD MATCHER ---
                                let hasKeywordMatch = profile.keywords.length === 0; 
                                
                                for (const kw of profile.keywords) {
                                    const stopWords = ['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'is', 'are', 'and', 'with', 'i', 'my'];
                                    const searchTerms = kw.split(' ').filter(term => term.trim() !== '' && !stopWords.includes(term));
                                    
                                    if (searchTerms.length === 0) continue;

                                    const matchCount = searchTerms.filter(term => fullTextToSearch.includes(term)).length;
                                    const requiredMatches = searchTerms.length <= 2 ? searchTerms.length : searchTerms.length - 1;

                                    if (matchCount >= requiredMatches) {
                                        hasKeywordMatch = true;
                                        break;
                                    }
                                }

                                if (hasKeywordMatch) usersToEvaluate.push(profile);
                            }
                        }

                        const evaluationPromises = usersToEvaluate.map(async (profile) => {
                            try {
                                const leadScore = await scorePostForUser(title, truncatedText, profile.agency);
                                
                                if (leadScore >= 6) {
                                    console.log(`✅ [${profile.agency.domain}] Local Match + AI Score ${leadScore}/10! Saving...`);
                                    
                                    const { error: dbError } = await supabase.from('leads').upsert([{
                                        user_id: profile.agency.id,
                                        tracker_id: profile.trackerIds[`sub_${sub}`], 
                                        reddit_post_id: id,
                                        title: title,
                                        body: selftext || '',
                                        subreddit: `r/${sub}`,
                                        url: permalink,
                                        posted_at: new Date(post.isoDate).toISOString()
                                    }], { onConflict: 'user_id, reddit_post_id', ignoreDuplicates: true });

                                    if (dbError) {
                                        console.error(`❌ DATABASE ERROR for ${profile.agency.domain}:`, dbError.message);
                                    } else {
                                        console.log(`✅ Lead saved for ${profile.agency.domain}`);
                                        
                                        // 1. WEBHOOK PING (If they have one)
                                        if (profile.webhookUrl) {
                                            const dashboardLink = "https://leadrnk.com/dashboard"; 
                                            const alertMessage = `🚨 *New High-Intent Lead Found!*\n*Target:* ${profile.agency.domain}\n*Score:* ${leadScore}/10\n*Subreddit:* r/${sub}\n\n👉 Login to generate an AI pitch: ${dashboardLink}`;

                                            try {
                                                await axios.post(profile.webhookUrl, { content: alertMessage, text: alertMessage });
                                            } catch (err) { console.log(`⚠️ Webhook failed.`); }
                                        }

                                        // 2. REAL-TIME EMAIL ALERT
                                        // We use the subreddit and a snippet of the title to make the subject line 100% unique every time to avoid Gmail spam filters.
                                        if (profile.email) { // Ensure you are pulling their email into the profile object!
                                            const cleanTitle = title.substring(0, 40) + "...";
                                            
                                            try {
                                                await resend.emails.send({
                                                    from: 'Jacob <alerts@leadrnk.com>', // MUST be a verified domain in Resend
                                                    to: profile.email,
                                                    subject: `Reddit Lead (r/${sub}): ${cleanTitle}`,
                                                    text: `We just found a highly qualified lead for ${profile.agency.domain}.\n\nSubreddit: r/${sub}\nIntent Score: ${leadScore}/10\nPost: ${title}\n\nLog into your dashboard to read the full post and use the AI Reply Agent to craft your pitch:\nhttps://leadrnk.vercel.app/dashboard\n\n- Leadrnk Automation`,
                                                });
                                                console.log(`📧 Email alert sent to ${profile.email}`);
                                            } catch (emailErr) {
                                                console.error(`⚠️ Email failed to send:`, emailErr.message);
                                            }
                                        }
                                    }

                                    if (dbError) console.error(`❌ DATABASE ERROR for ${profile.agency.domain}:`, dbError.message);
                                }
                            } catch (e) { console.error(`Error scoring ${profile.agency.domain}:`, e.message); }
                        });
                        
                        await Promise.all(evaluationPromises);
                        processedPosts.add(id);
                    }
                } catch (err) {
                    console.error(`⚠️ Failed on r/${sub}: ${err.message}`);
                }
            }));
            
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (processedPosts.size > 5000) processedPosts.clear();
        console.log('Scan complete for this cycle.');

    } catch (err) {
        console.error("Fatal Scraper Error:", err);
    }
}

cron.schedule('*/15 * * * *', () => {
    scanReddit();
});

console.log('Sublurker RSS Scraper initialized. Running first scan now, then every 15 minutes...');
scanReddit();