const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const cheerio = require('cheerio');
const axios = require('axios');
const Parser = require('rss-parser');

const app = express();

app.use(express.json());


// Allow your Vercel frontend to talk to this backend
app.use(cors({
    origin: ['https://www.leadrnk.com', 'http://localhost:5173'], // Add your exact Vercel URL here
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));

app.use(express.json());
// ... rest of your server code

// Initialize Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const parser = new Parser();

// --- HELPER: AI SCORING FOR HISTORICAL SCAN ---
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

// --- HELPER: BACKGROUND HISTORICAL SCANNER ---
async function populateInitialFeed(userId, agency, generatedTrackers) {
    console.log(`🚀 Kicking off 6-hour historical deep scan for new user: ${agency.domain}`);
    
    try {
        const subreddits = new Set();
        const profile = { agency, keywords: [], trackerIds: {} };
        
        generatedTrackers.forEach(t => {
            if (t.subreddit) {
                const cleanSub = t.subreddit.toLowerCase().replace('r/', '').trim();
                subreddits.add(cleanSub);
                profile.trackerIds[`sub_${cleanSub}`] = t.id; 
            }
            if (t.keyword) {
                profile.keywords.push(t.keyword.toLowerCase().trim());
            }
        });

        for (const sub of subreddits) {
            try {
                // Request 200 (Note: Reddit will likely cap this at 100, but we cast the widest net possible)
                const response = await axios.get(`https://www.reddit.com/r/${sub}/new.rss?limit=200`, {
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
                        'Accept': 'application/rss+xml, application/xml'
                    }
                });
                
                const feed = await parser.parseString(response.data);

                for (const post of feed.items) {
                    const created_utc = new Date(post.isoDate).getTime() / 1000;
                    const postAgeInMinutes = (Math.floor(Date.now() / 1000) - created_utc) / 60;
                    
                    // Look back 24 hours (1440 minutes)
                    if (postAgeInMinutes > 1440) continue; 

                    const title = post.title || '';
                    const selftext = post.contentSnippet || post.content || '';
                    const fullTextToSearch = `${title} ${selftext}`.toLowerCase();

                    // --- SMART FLEXIBLE KEYWORD MATCHER ---
                    let hasKeywordMatch = profile.keywords.length === 0; 
                    for (const kw of profile.keywords) {
                        // 1. Remove useless stop words that break matches
                        const stopWords = ['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'is', 'are', 'and', 'with', 'i', 'my'];
                        const searchTerms = kw.split(' ').filter(term => term.trim() !== '' && !stopWords.includes(term));
                        
                        if (searchTerms.length === 0) continue;

                        // 2. Count how many of the core words actually appear in the post
                        const matchCount = searchTerms.filter(term => fullTextToSearch.includes(term)).length;
                        
                        // 3. If it's 1-2 words, require all. If 3+ words, allow 1 missing word (partial match).
                        const requiredMatches = searchTerms.length <= 2 ? searchTerms.length : searchTerms.length - 1;

                        if (matchCount >= requiredMatches) {
                            hasKeywordMatch = true;
                            break;
                        }
                    }

                    if (hasKeywordMatch) {
                        const truncatedText = selftext.length > 500 ? selftext.substring(0, 500) + '...' : selftext;
                        const leadScore = await scorePostForUser(title, truncatedText, profile.agency);
                        
                        if (leadScore >= 6) {
                            console.log(`✅ [Historical] Found lead for ${agency.domain}! Score: ${leadScore}/10`);
                            await supabase.from('leads').upsert([{
                                user_id: userId,
                                tracker_id: profile.trackerIds[`sub_${sub}`], 
                                reddit_post_id: post.id || post.guid,
                                title: title,
                                body: selftext || '',
                                subreddit: `r/${sub}`,
                                url: post.link,
                                posted_at: new Date(post.isoDate).toISOString() // Keeping your accurate time fix!
                            }], { onConflict: 'user_id, reddit_post_id', ignoreDuplicates: true });
                        }
                    }
                }
            } catch (err) {
                console.log(`⚠️ Historical scan skipped r/${sub}: ${err.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        console.log(`🎉 Historical deep scan complete for ${agency.domain}`);
    } catch (error) {
        console.error('Fatal error in historical scan:', error);
    }
}

// --- HEALTH CHECK ROUTE ---
app.get('/api/test', (req, res) => {
    res.status(200).json({ message: "Leadrnk Backend is loud and clear!" });
});

// --- GENERATE TRACKERS ROUTE ---
app.post('/api/generate-trackers', async (req, res) => {
    const { userId } = req.body;

    try {
        const { data: agency, error: agencyError } = await supabase
            .from('agencies')
            .select('*')
            .eq('id', userId)
            .single();

        if (agencyError || !agency) return res.status(404).json({ error: 'Agency profile not found' });

        let scrapedContext = "No website content available.";
        if (agency.domain) {
            try {
                const targetUrl = agency.domain.startsWith('http') ? agency.domain : `https://${agency.domain}`;
                const siteResponse = await axios.get(targetUrl, { 
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    }
                });
                
                const $ = cheerio.load(siteResponse.data);
                scrapedContext = `
                    Website Title: ${$('title').text().trim()}
                    Meta Description: ${$('meta[name="description"]').attr('content') || ''}
                    Homepage Copy Snippet: ${$('p').slice(0, 5).text().replace(/\s+/g, ' ').substring(0, 800)}
                `;
                console.log(`Successfully scraped context from ${agency.domain}`);
            } catch (scrapeErr) {
                console.log(`⚠️ Could not scrape ${agency.domain}. Reason: ${scrapeErr.message}`);
            }
        }

        const prompt = `
            You are an expert B2B lead generation strategist. 
            I run a business with this description: "${agency.description}"
            My main competitors are: ${agency.competitor1} and ${agency.competitor2}.
            
            Here is the actual scraped text from my website's homepage to give you exact context on what I sell:
            START WEBSITE CONTEXT
            ${scrapedContext}
            END WEBSITE CONTEXT
            
            I am using a Reddit keyword tracker to find potential clients. 
            Generate exactly 40 highly targeted keyword phrases. 
            For each keyword, assign the SINGLE most relevant subreddit to track it in. You do NOT need 40 unique subreddits; reuse the top 10 to 20 most relevant niche subreddits across all 40 keywords.
            
            CRITICAL RULES:
            1. Keyword Length: Every single keyword phrase MUST be exactly 2 or 3 words long. No exceptions.
            2. The 50/50 Mix: Half of the keywords MUST be broad buyer pain points (e.g., "get clients", "increase sales", "find an agency"). The other half MUST be highly specific to my actual services based on the website context (e.g., if I am an SEO agency, include "need backlinks", "local seo help", "seo audit").
            3. Subreddits: Assign the best subreddit for that specific keyword. Keep it focused on business, SaaS, or niche-relevant communities.
            4. Quantity: You MUST generate exactly 40 JSON objects. No duplicates.
            
            Return ONLY a raw JSON array of 40 objects with "keyword" and "subreddit" keys. Do not include markdown formatting or backticks.
        `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
        });

        const cleanJson = completion.choices[0].message.content.trim().replace(/```json/g, '').replace(/```/g, '');
        const generatedTrackers = JSON.parse(cleanJson).slice(0, 40);

        const trackersToInsert = generatedTrackers.map(t => ({
            user_id: userId,
            keyword: t.keyword.toLowerCase(), 
            subreddit: t.subreddit
        }));

        // Insert and explicitly .select() to get the generated IDs back!
        const { data: insertedTrackers, error: insertError } = await supabase
            .from('trackers')
            .insert(trackersToInsert)
            .select();

        if (insertError) throw insertError;

        // Fire off the background scanner WITHOUT await so it doesn't block the frontend!
        populateInitialFeed(userId, agency, insertedTrackers);

        res.json({ success: true, count: insertedTrackers.length });

    } catch (err) {
        console.error('Generation Error:', err);
        res.status(500).json({ error: 'Failed to generate trackers' });
    }
});

// --- GENERATE REDDIT COMMENT ROUTE ---
app.post('/api/generate-reply', async (req, res) => {
    const { userId, leadId, leadTitle, leadBody } = req.body;

    try {
        // 1. Fetch the user's agency profile for context
        const { data: agency, error: agencyError } = await supabase
            .from('agencies')
            .select('*')
            .eq('id', userId)
            .single();

        if (agencyError || !agency) {
            return res.status(404).json({ error: 'Agency profile not found' });
        }

        // 2. The "Soft-Sell" Reddit Prompt
        const prompt = `
            You are a highly respected, veteran user on Reddit. You are also an expert at: "${agency.description}".
            
            A Reddit user just posted this:
            Title: "${leadTitle}"
            Body: "${leadBody}"
            
            Write a highly valuable, thoughtful Reddit comment in response. 
            
            CRITICAL RULES:
            1. NEVER greet tackle the question striaght away or use "hey there"
            2. Tone: Be casual, conversational, and helpful. Use formatting like short paragraphs or bullet points if needed. Do NOT sound corporate or salesy. 
            3. Value First: Provide 1 or 2 pieces of actual, actionable advice related to their specific problem.
            4. The "Soft Flex": Subtly weave in your expertise. Use a phrase similar to "In my experience running an agency in this space..." or "We recently helped a client with this exact issue...".
            5. No Hard Selling: Do NOT tell them to DM you. Do NOT tell them to visit your website. End the comment with an open-ended question to start a conversation, or a simple "Hope this helps!".
            6. Length: Keep it between 3 to 5 short paragraphs.
            
            
            Return ONLY the raw text of the comment. Do not use quotes or markdown code blocks.
        `;

        // 3. Call OpenAI (Using gpt-4o for high-quality, human-like writing)
        const completion = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7, // Add a little creativity so it doesn't sound robotic
        });

        const generatedReply = completion.choices[0].message.content.trim();

        res.json({ success: true, reply: generatedReply });

    } catch (err) {
        console.error('Reply Generation Error:', err);
        res.status(500).json({ error: 'Failed to generate reply' });
    }
});
// --- FLUTTERWAVE WEBHOOK (Recurring Billing) ---
app.post('/api/webhook/flutterwave', async (req, res) => {
    // 1. Verify the request actually came from Flutterwave
    const secretHash = process.env.FLW_WEBHOOK_SECRET; 
    const signature = req.headers['verif-hash'];
    
    if (!signature || signature !== secretHash) {
        return res.status(401).end();
    }
    
    const payload = req.body;
    
    // 2. Extract the User ID from the custom tx_ref we built
    const txRef = payload.data?.tx_ref || '';
    const parts = txRef.split('_');
    const userId = parts[2]; // Grabs the user ID from "leadrnk_growth_USERID_12345"

    if (!userId) return res.status(200).end(); 

    try {
        if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
            // Monthly renewal succeeded! Keep their account active.
            await supabase.from('agencies').update({ is_paid: true }).eq('id', userId);
            console.log(`♻️ Auto-renewal successful for user: ${userId}`);
        } 
        else if (payload.event === 'charge.failed') {
            // Card declined or expired! Revoke AI access.
            await supabase.from('agencies').update({ is_paid: false }).eq('id', userId);
            console.log(`❌ Auto-renewal failed for user: ${userId}. Access revoked.`);
        }
    } catch (err) {
        console.error('Webhook database error:', err);
    }
    
    // Always return 200 OK so Flutterwave stops retrying the ping
    res.status(200).end(); 
});

// --- CANCEL SUBSCRIPTION ROUTE ---
// --- CANCEL SUBSCRIPTION ROUTE (Fully Automated) ---
app.post('/api/cancel-subscription', async (req, res) => {
    // We now expect the frontend to pass the user's email too
    const { userId, email } = req.body; 
    
    try {
        const flwSecret = process.env.FLW_SECRET_KEY; // Your Flutterwave Secret Key
        
        if (!flwSecret) {
            console.error('Missing FLW_SECRET_KEY in environment variables.');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        // 1. Ask Flutterwave for all subscriptions attached to this user's email
        const subsResponse = await axios.get(`https://api.flutterwave.com/v3/subscriptions?email=${email}`, {
            headers: { Authorization: `Bearer ${flwSecret}` }
        });

        const subscriptions = subsResponse.data.data || [];

        // 2. Loop through and cancel any that are currently active
        for (const sub of subscriptions) {
            if (sub.status === 'active') {
                await axios.put(`https://api.flutterwave.com/v3/subscriptions/${sub.id}/cancel`, {}, {
                    headers: { Authorization: `Bearer ${flwSecret}` }
                });
                console.log(`🛑 Successfully cancelled Flutterwave sub ${sub.id} for ${email}`);
            }
        }

        // 3. Instantly revoke AI access and downgrade them to the base free tier in your app
        await supabase.from('agencies').update({ 
            is_paid: false,
            plan: 'freelancer' 
        }).eq('id', userId);

        res.json({ success: true });
    } catch (err) {
        console.error('Cancellation API error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to cancel subscription on Flutterwave.' });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Leadrnk Backend running on http://localhost:${PORT}`);
});