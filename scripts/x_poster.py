#!/usr/bin/env python3
"""
x_poster.py

Polls content_queue in Supabase for pending tweets and posts them to X.
Run anywhere: VPS, Railway, Render, your laptop.

Requires:
    pip install tweepy supabase python-dotenv

Env vars needed (from .env or environment):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    X_API_KEY
    X_API_SECRET
    X_ACCESS_TOKEN
    X_ACCESS_TOKEN_SECRET
"""

import os
import time
import logging
from datetime import datetime, timezone

import tweepy
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

POLL_INTERVAL = 60  # seconds between queue checks


def get_supabase():
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def get_twitter():
    return tweepy.Client(
        consumer_key=os.environ["X_API_KEY"],
        consumer_secret=os.environ["X_API_SECRET"],
        access_token=os.environ["X_ACCESS_TOKEN"],
        access_token_secret=os.environ["X_ACCESS_TOKEN_SECRET"],
    )


def process_queue(sb, twitter):
    result = (
        sb.table("content_queue")
        .select("*")
        .eq("status", "pending")
        .eq("platform", "twitter")
        .order("created_at")
        .limit(5)
        .execute()
    )

    rows = result.data or []
    if not rows:
        return

    log.info(f"Found {len(rows)} pending tweet(s)")

    for row in rows:
        try:
            response = twitter.create_tweet(text=row["content"])
            tweet_id = response.data["id"]
            log.info(f"Posted tweet {tweet_id}: {row['content'][:60]}...")

            sb.table("content_queue").update({
                "status": "posted",
                "posted_at": datetime.now(timezone.utc).isoformat(),
                "platform_post_id": tweet_id,
            }).eq("id", row["id"]).execute()

        except tweepy.TweepyException as e:
            log.error(f"Failed to post tweet {row['id']}: {e}")
            sb.table("content_queue").update({
                "status": "failed",
                "error": str(e),
            }).eq("id", row["id"]).execute()

        time.sleep(2)  # brief pause between posts


def main():
    log.info("x_poster starting up")
    sb = get_supabase()
    twitter = get_twitter()
    log.info("Connected to Supabase and Twitter API")

    while True:
        try:
            process_queue(sb, twitter)
        except Exception as e:
            log.error(f"Queue processing error: {e}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
