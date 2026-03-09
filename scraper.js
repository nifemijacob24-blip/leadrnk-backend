const axios = require('axios');
const cron = require('node-cron');
const { OpenAI } = require('openai');
require('dotenv').config();
const { HttpsProxyAgent } = require('https-proxy-agent');
const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const { Resend } = require('resend');

// --- YOUR MASTER CURATED SUBREDDIT LIST ---
// Add your 100 researched subreddits here. Do not include 'r/'.
const GLOBAL_SUBREDDITS = [
    'advertising',
    'agency',
    'agencygrowthhacks',
    'askmarketing',
    'askuaebusiness',
    'aws',
    'blogging',
    'business',
    'business_ideas',
    'coldemail',
    'content_marketing',
    'contentmarketing',
    'customersuccess',
    'devops',
    'digital_marketing',
    'digitalmarketing',
    'digitalmarketinghack',
    'dropship',
    'dropshipping',
    'ecommerce',
    'ecommercemarketing',
    'emailmarketing',
    'emailmarketingnow',
    'entrepreneur',
    'entrepreneurridealong',
    'entrepreneurs',
    'entrepreneurship',
    'facebookads',
    'facebookadvertising',
    'flutterdev',
    'freelancing',
    'freeloopkits',
    'golang',
    'googleads',
    'googleadwords',
    'growthhacking',
    'indiehackers',
    'instructionaldesign',
    'java',
    'javascript',
    'journalism',
    'journalismjobs',
    'kotlin',
    'kubernetes',
    'ladybusiness',
    'leadgeneration',
    'learnjavascript',
    'legalmarketing',
    'marketing',
    'marketing_design',
    'marketinghelp',
    'microsaas',
    'nextjs',
    'node',
    'nonprofit',
    'nonprofit_jobs',
    'nonprofit_marketing',
    'nonprofittech',
    'postgresql',
    'ppc',
    'ppcjobs',
    'publicrelations',
    'react',
    'reactjs',
    'reactnative',
    'saas',
    'saasmarketing',
    'sales',
    'salesdevelopment',
    'salesengineers',
    'salesoperations',
    'salestechniques',
    'seo',
    'seo_digital_marketing',
    'shopifyecommerce',
    'sideproject',
    'sideprojects',
    'sideprojectwins',
    'small_business_ideas',
    'smallbusiness',
    'socialmedia',
    'socialmediamanagers',
    'socialmediamarketing',
    'sre',
    'startups',
    'supabase',
    'sweatystartup',
    'techsales',
    'techsalesjobs',
    'terraform',
    'typescript',
    'webdev',
    'ycombinator'
];

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

// 3. Safe Proxy Init
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
                httpsAgent: httpsAgent ? httpsAgent : undefined,
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
            model: "gpt-4.1-mini", 
            messages: [
                {
                    role: "system",
                    content: `You are an expert lead qualification AI. Read the Reddit post and evaluate if the user is a highly qualified lead for this business:
                    
                    Business Domain: "${agency.domain}"
                    Business Pitch/Description: "${agency.description}"
                    Competitors: ${agency.competitor1}, ${agency.competitor2}


                    Score the post from 1 to 10 based on how badly this person needs this exact business's services or if they are showing high buyer intent and not trying to sell something they must be in need of my help to get 6 and above.
                    
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
    console.log('\nStarting Sublurker RSS Scanner (Global Subreddits + Custom Keywords)...');
    
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
            if (agency.is_paid) return true; 
            if (agency.trial_ends_at && new Date(agency.trial_ends_at) > now) return true; 
            return false; 
        });

        // Setup Profiles
        activeAgencies.forEach(agency => {
            userProfiles.set(agency.id, {
                agency: agency,
                keywords: [],
                trackerIds: {}, 
                webhookUrl: agency.webhook_url,
                email: agency.email // MAKE SURE 'email' EXISTS IN YOUR AGENCIES TABLE!
            });
        });

        // Map ONLY keywords to users (WITH PLAN LIMITS)
        trackers.forEach(t => {
            const profile = userProfiles.get(t.user_id);
            if (!profile || !t.keyword) return;

            // 🚨 THE ENFORCER: Check their plan limit before adding the keyword to the scraper
            const maxAllowed = profile.agency.plan === 'growth' ? 40 : 20;
            if (profile.keywords.length >= maxAllowed) return; // Stop adding keywords for this user!

            const cleanKey = t.keyword.toLowerCase().trim();
            profile.keywords.push(cleanKey);
            profile.trackerIds[`kw_${cleanKey}`] = t.id;
        });

        const chunkArray = (array, size) => {
            const chunked = [];
            for (let i = 0; i < array.length; i += size) chunked.push(array.slice(i, i + size));
            return chunked;
        };

        console.log(`Scanning Master List of ${GLOBAL_SUBREDDITS.length} Curated Subreddits...`);
        const subredditBatches = chunkArray(GLOBAL_SUBREDDITS, 2);
        
        for (const batch of subredditBatches) {
            await Promise.all(batch.map(async (sub) => {
                try {
                    const response = await fetchWithRetry(`https://www.reddit.com/r/${sub}/new.rss?limit=5`);
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

                        // 4. THE MATCHER: Check this post against EVERY user's keywords
                        for (const [userId, profile] of userProfiles.entries()) {
                            let hasKeywordMatch = false; 
                            
                            for (const kw of profile.keywords) {
                                const stopWords = ['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'is', 'are', 'and', 'with', 'i', 'my'];
                                const searchTerms = kw.split(' ').filter(term => term.trim() !== '' && !stopWords.includes(term));
                                
                                if (searchTerms.length === 0) continue;

                                const matchCount = searchTerms.filter(term => fullTextToSearch.includes(term)).length;
                                const requiredMatches = searchTerms.length <= 2 ? searchTerms.length : searchTerms.length - 1;

                                if (matchCount >= requiredMatches) {
                                    hasKeywordMatch = true;
                                    // Temporarily store the ID of the specific keyword that matched
                                    profile.matchedTrackerId = profile.trackerIds[`kw_${kw}`];
                                    break;
                                }
                            }

                            if (hasKeywordMatch) usersToEvaluate.push(profile);
                        }

                        // Evaluate and Save Leads
                        const evaluationPromises = usersToEvaluate.map(async (profile) => {
                            try {
                                const leadScore = await scorePostForUser(title, truncatedText, profile.agency);
                                
                                if (leadScore >= 6) {
                                    // 🚨 NEW FIX: Add .select() to get the result back
                                    const { data: insertedLead, error: dbError } = await supabase.from('leads').upsert([{
                                        user_id: profile.agency.id,
                                        tracker_id: profile.matchedTrackerId, 
                                        reddit_post_id: id,
                                        title: title,
                                        body: selftext || '',
                                        subreddit: `r/${sub}`,
                                        url: permalink,
                                        posted_at: new Date(post.isoDate).toISOString()
                                    }], { onConflict: 'user_id, reddit_post_id', ignoreDuplicates: true }).select();

                                    if (dbError) {
                                        console.error(`❌ DATABASE ERROR for ${profile.agency.domain}:`, dbError.message);
                                    } 
                                    // 🚨 THE SHIELD: Only send emails if Supabase confirms it is a BRAND NEW row!
                                    else if (insertedLead && insertedLead.length > 0) {
                                        console.log(`✅ NEW Lead saved for ${profile.agency.domain}`);
                                        
                                        // 1. WEBHOOK PING 
                                        if (profile.webhookUrl) {
                                            const dashboardLink = "https://sublurker.com/dashboard"; 
                                            const alertMessage = `🚨 *New High-Intent Lead Found!*\n*Target:* ${profile.agency.domain}\n*Score:* ${leadScore}/10\n*Subreddit:* r/${sub}\n\n👉 Login to generate an AI pitch: ${dashboardLink}`;

                                            try {
                                                await axios.post(profile.webhookUrl, { content: alertMessage, text: alertMessage });
                                            } catch (err) { console.log(`⚠️ Webhook failed.`); }
                                        }

                                        // 2. REAL-TIME EMAIL ALERT
                                        if (profile.email) { 
                                            const cleanTitle = title.substring(0, 40) + "...";
                                            try {
                                                await resend.emails.send({
                                                    from: 'Jacob <alerts@sublurker.com>',
                                                    to: profile.email,
                                                    subject: `Reddit Lead for ${profile.agency.domain}`,
                                                    text: `We just found a highly qualified lead for ${profile.agency.domain}.\n\nSubreddit: r/${sub}\nIntent Score: ${leadScore}/10\nPost: ${title}\n\nLog into your dashboard to read the full post and use the AI Reply Agent to craft your pitch:\nhttps://sublurker.com/dashboard\n\n- sublurker Automation`,
                                                });
                                                console.log(`📧 Email alert sent to ${profile.email}`);
                                            } catch (emailErr) {
                                                console.error(`⚠️ Email failed to send:`, emailErr.message);
                                            }
                                        }
                                    } else {
                                        // It was a duplicate, silently ignore it!
                                        console.log(`🔄 Ignored duplicate post for ${profile.agency.domain}`);
                                    }
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