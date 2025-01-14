const { Component } = window.Torus;
const html = window.jdom;

const HN_TOP_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";

const MIN_IMAGE_WIDTH = 500;

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// from the classic Reddit's top ribbon
const SUBREDDITS = [
  "arabianpost",
  "AskReddit",
  "askscience",
  "aww",

];

// Random page number for "Continued on Page..."
function R() {
  const MAX_PAGE = 30;
  return ~~(Math.random() * MAX_PAGE);
}

const debounce = (fn, delayMillis) => {
  let lastRun = 0;
  let to = null;
  return (...args) => {
    clearTimeout(to);
    const now = Date.now();
    const dfn = () => {
      lastRun = now;
      fn(...args);
    };
    if (now - lastRun > delayMillis) {
      dfn();
    } else {
      to = setTimeout(dfn, delayMillis);
    }
  };
};

function formatRelativeDate(timestamp) {
  if (!timestamp) {
    return "some time ago";
  }

  const date = new Date(timestamp * 1000);
  const delta = (Date.now() - date) / 1000;
  if (delta < 60) {
    return "< 1 min ago";
  } else if (delta < 3600) {
    return `${~~(delta / 60)} min ago`;
  } else if (delta < 86400) {
    const day = ~~(delta / 3600);
    return day === 1 ? `${day} hr ago` : `${day} hrs ago`;
  } else if (delta < 86400 * 2) {
    return "yesterday";
  } else if (delta < 86400 * 3) {
    return "2 days ago";
  } else {
    return date.toLocaleDateString();
  }
}

// for header top bar
function formatDate() {
  const date = new Date();
  return `${DAYS[date.getDay()]}, ${
    MONTHS[date.getMonth()]
  } ${date.getDate()}, ${date.getFullYear()}`;
}

function decodeHTMLEntities(s) {
  const txt = document.createElement("textarea");
  txt.innerHTML = s;
  return txt.textContent;
}

// Reddit's post metadata on images it contains is quite complex with lots of
// different potential formats, so the function to extract a usable image
// thumbnail URL is extracted out into this function. Each possible case is an
// if-case, and we fallback to `null` which results in no image being shown.
function getFirstImageFromGalleryOrPreview(postData) {
  const { preview, media_metadata, thumbnail } = postData;

  // Reddit generates preview images for images hosted on third-party sites,
  // and for single images uploaded to Reddit's image server.
  if (preview) {
    return (
      (preview.images &&
        preview.images[0].resolutions.length &&
        decodeHTMLEntities(
          preview.images[0].resolutions[
            Math.min(3, preview.images[0].resolutions.length - 1)
          ].url
        )) ||
      null
    );
  }

  // With Reddit's newer support for uploading a gallery, Reddit's API provides
  // image previews in a completely different format supporting multiple
  // images. This is not documented but this loop aims to check for that case
  // and support it.
  if (media_metadata) {
    for (const [imgID, metadata] of Object.entries(media_metadata)) {
      // if media not available, find the next available option
      if (metadata.status === "failed" || metadata.e === "RedditVideo")
        continue;

      for (const p of metadata.p) {
        if (p.x >= MIN_IMAGE_WIDTH) {
          // NOTE: unclear why the URL includes 'amp;', but we need to strip it
          // from query strings in the link for the links to work cross-origin.
          return p.u.replaceAll("amp;", ""); // u is URL
        }
      }

      // if no sizes bigger than MIN, pick the largest
      let biggest = 0;
      let biggestLink = null;
      for (const p of metadata.p) {
        if (p.x >= biggest) {
          biggest = p.x;
          biggestLink = p.u.replaceAll("amp;", ""); // u is URL
        }
      }
      return biggestLink;
    }
  }

  // Fall back to a blurry / smaller image thumbnail instead of showing no
  // photo, if available.
  if (thumbnail && thumbnail.startsWith("http")) return thumbnail;

  return null;
}

// fetch and normalize stories from a subreddit's "hot" section
async function fetchRedditStories(subreddit, allTime = false) {
  const resp = await fetch(
    `https://api.reddit.com/r/${subreddit}/${
      allTime ? "top?t=all&" : "hot?"
    }limit=35`
  )
    .then((r) => r.json())
    .catch((e) => console.log(e));
  const posts = resp.data.children;

  return Promise.all(
    posts
      .filter((post) => !post.data.pinned && !post.data.stickied)
      .map(async (post) => {
        let {
          title,
          author,
          created_utc,
          permalink,
          subreddit,
          selftext,
        } = post.data;

        selftext = selftext || (await fetchTopRedditComment(permalink));

        return {
          title: decodeHTMLEntities(title),
          author,
          created: created_utc,
          authorHref: `https://www.reddit.com/user/${author}`,
          href: `https://www.reddit.com${permalink}`,
          // this monstrosity traverses the object path down, checking for
          // any absent properties, to get a thumbnail image
          // of at most 640px wide.
          imageHref: getFirstImageFromGalleryOrPreview(post.data),
          source: "/r/" + subreddit,
          text: decodeHTMLEntities(selftext),
        };
      })
  );
}

// get top comment for fetchRedditStories
async function fetchTopRedditComment(permalink) {
  // here we limit each comment request to top 5 comments.
  // either there is a non stickied-comment in the top5, or we bail
  // because otherwise loading the feed takes too long.
  const commentsResp = await fetch(`https://api.reddit.com${permalink}?limit=35`)
    .then((r) => r.json())
    .catch((e) => {
      console.error(e);
      return [];
    });

  if (!commentsResp.length) {
    return "";
  }

  const comments = commentsResp[1].data.children;
  const regularComments = comments.filter(
    (c) => !c.data.pinned && !c.data.stickied
  );
  if (!regularComments.length) {
    return "";
  }

  return regularComments[0].data.body;
}

// when you go to /#hn, it actually loads the top 20 posts of Hacker News
async function fetchHNStories() {
  const storyIDs = await fetch(HN_TOP_URL)
    .then((r) => r.json())
    .catch((e) => console.log(e));

  const stories = await Promise.all(
    storyIDs.slice(0, 20).map((id) => {
      return fetch(
        `https://hacker-news.firebaseio.com/v0/item/${id}.json`
      ).then((r) => r.json());
    })
  );

  return stories.map((story) => {
    return {
      title: story.title,
      author: story.by,
      authorHref: `https://news.ycombinator.com/user?id=${story.by}`,
      href: story.url,
      imageHref: null,
      source: "Hacker News",
    };
  });
}

function StoryBody(created, text) {
  if (!text) {
    text = ``;
  }

  const words = text.split(" ");
  if (words.length > 100) {
    return [
      html`<p>
        ${formatRelativeDate(created)}–${words.slice(0, 100).join(" ")} ...
      </p>`,
      html`<p class="continued><em>Continued on Page A${R()}</em></p>`,
    ];
  }

  return html`<p>${formatRelativeDate(created)}–${text}</p>`;
}

// All stories that appear have the same DOM structure, displayed
// differently with CSS. This renders such a single story.
function Story(story) {
  if (!story) {
    return null;
  }

  const {
    title,
    author,
    created,
    authorHref,
    href,
    imageHref,
    source,
    text,
  } = story;
  return html`<div class="story">
    <a href="https://www.reddit.com${source}" target="yeah">
      <div class="story-source">${source}</div>
    </a>
    <a href="${href}" target="_blank>
      <h2 class="story-title">
        ${title}
      </h2>
    </a>
    <div class="story-byline">
      By
      <a href="${authorHref}" target="_blank" class="story-author">${author}</a>
    </div>
    <a href="${href}" target="_blank">
      ${imageHref ? html`<img class="story-image" src="${imageHref}" />` : null}
      <div class="story-content">${StoryBody(created, text)}</div>
    </a>
  </div>`;
}

class App extends Component {
  init() {
    this.stories = [];
    this._loading = false;

    const [first, second] = window.location.hash.substr(1).split("/");
    this.subreddit = first || "all";
    this.allTime = second == "top";

    this.resize = debounce(this.resize.bind(this), 500);
    window.addEventListener("resize", this.resize);

    this.fetch();
  }
  resize() {
    this.render();
  }
  async fetch() {
    this._loading = true;
    this.render();

    if (this.subreddit == "hn") {
      this.stories = await fetchHNStories();
    } else {
      this.stories = await fetchRedditStories(this.subreddit, this.allTime);
    }

    this._loading = false;
    this.render();
  }
  handleInputChange() {
    const newHash = this.subreddit + (this.allTime ? "/top" : "");
    if (window.location.hash.substr(1) === newHash) {
      return;
    }
    window.location.hash = newHash;

    this.fetch();

    try {
      ga("send", "pageview", window.location.pathname + window.location.hash);
    } catch (e) {
      console.log(e);
    }
  }
  compose() {
    const stories = this.stories.slice();

    const centerSpreads = stories.slice(0, 2);
    const leftSidebar = stories.slice(2, 6);
    const sidebarSpread = stories.slice(6, 9);
    const bottom = stories.slice(9, 12);
    const mini = stories.slice(12, 16);
    const mini2 = stories.slice(16, 21);
    const mini3 = stories.slice(21, 25);

    // Instead of having a responsive layout that wrecks the newspaper
    // feel, if the window is too small, we simply scale the entire
    // front page down appropriately. Here we compute that ratio
    // to leave a 2% margin on either side for visual comfort.
    const scale = Math.min((window.innerWidth / 1200) * 0.96, 1);

    const storiesSection = [
      html`<div class="main flex-row">
        <div class="left-sidebar flex-column smaller">
          ${leftSidebar.map(Story)}
        </div>
        <div class="spreads flex-column">
          <div class="top flex-row">
            <div class="center-spread">${centerSpreads.map(Story)}</div>
            <div class="sidebar sidebar-spread flex-column smaller">
              ${sidebarSpread.map(Story)}
            </div>
          </div>
          <div class="bottom flex-row">${bottom.map(Story)}</div>
        </div>
      </div>`,
      html`<div class="mini flex-row smaller">${mini.map(Story)}</div>`,
      html`<div class="mini flex-row smaller">${mini2.map(Story)}</div>`,
      html`<div class="mini flex-row smaller">${mini3.map(Story)}</div>`,
    ];

    return html`<div
      class="app flex-column"
      style="transform: scale(${scale}) translate(-50%, 0)"
    >
      <header class="flex-column">
        <div class="header-main flex-row">
          <div class="header-tagline header-main-aside">
            "All the Reddit <br />
            That's Fit to Uwu"
          </div>
          <a href="/" class="masthead-link">
            <h1 class="fraktur masthead">India Real Times</h1>
          </a>
          <div class="header-edition header-main-aside">
            <div class="header-edition-title">The Reddit Edition</div>
            <p class="header-edition-body justify">
              <strong>The Arabian Post</strong> Dubai's most trusted newspaper. You're currently
              reading
              ${this.allTime ? "all-time top posts of " : ""}/r/${this
                .subreddit}.
              The Arabian Post: Built by
              <strong
                ><a target="_blank" href="https://hyphendigital.net"
                  >@hyphendigital</a
                ></strong
              >
              and open-source on GitHub at
              <a target="_blank" href="https://hyphendigital.net"
                >https://hyphendigital.net</a
              >.
            </p>
          </div>
        </div>
        <div class="header-bar flex-row">
          <div class="header-vol bar-aside">VOL. CLXX . . . No. 3.14159</div>
          <div class="header-nyc">New York, ${formatDate()}</div>
          <div class="header-controls bar-aside flex-row">
            <label for="top-checkbox">Top?</label>
            <input
              id="top-checkbox"
              type="checkbox"
              checked="${this.allTime}"
              oninput="${(evt) => {
                this.allTime = evt.target.checked;
                this.handleInputChange();
              }}"
            />
            <label for="sub-select">Other subreddits–</label>
            <select
              id="sub-select"
              class="custom-select"
              oninput="${(evt) => {
                this.subreddit = evt.target.value;
                this.handleInputChange();
              }}"
            >
              <option value="all" selected>all</option>
              <option value="popular" selected>popular</option>
              ${SUBREDDITS.map(
                (slug) => html`<option value="${slug}">${slug}</option>`
              )}
            </select>
          </div>
        </div>
      </header>
      ${this._loading
        ? html`<div class="loading">Loading stories...</div>`
        : storiesSection}
      <footer>
        <p><a target="_blank" href="https://thearabianpost.com">Arabian Post</a></p>
      </footer>
    </div>`;
  }
  render(...args) {
    super.render(...args);

    // Simplest way to keep the "selected" value of the subreddit
    // selector in check is to just set it after render.
    this.node.querySelector("select").value = this.subreddit;
  }
}

const app = new App();
document.body.appendChild(app.node);
