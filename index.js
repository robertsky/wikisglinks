const _ = require('lodash');
const colors = require('colors');
const cliProgress = require('cli-progress');
const Promise = require('bluebird');
const wiki = require('wikijs').default;
const winston = require('winston');
const fs = Promise.promisifyAll(require('fs'));

const waitFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_ATTEMPTS = 6;
const REQUEST_INTERVAL_MS = 1000;
const REQUEST_JITTER_MS = 500;

const CATEGORY_LIST_FILE = 'category-list.txt';
const CATEGORY_CHANGE_LOG_FILE = 'logs/category-changes.log';
const USER_AGENT =
    'WikiSgLinksBot/1.2.0 ' +
    '(https://github.com/robertsky/wikisglinks; ' +
    'contact: contact@robertsky.com) ' +
    'wikijs/6.4.1';

let limiterQueue = Promise.resolve();
let nextRequestAt = 0;
let globalBlockedUntil = 0;

const outputArray = [];

const wikipedia = wiki({
    apiUrl: 'https://en.wikipedia.org/w/api.php',
    headers: {
        'User-Agent': USER_AGENT
    }
});

const progress = new cliProgress.SingleBar({
    format:
        'Categories accessed |' +
        colors.cyan('{bar}') +
        '| {percentage}% || {value}/{total} categories',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
});

const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            level: 'warn',
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({
            level: 'error',
            filename: 'logs/error.log'
        })
    ]
});

function normaliseTitle(title) {
    let result = title
        .replace(/^Talk:/, '')
        .replace(/^Book talk:/, 'Book:');

    switch (result) {
        case 'Singapore Armed Forces Training Institute':
        case 'Judge of Singapore':
            result += ' (disambiguation)';
            break;
    }

    return result;
}

function shouldIncludeTitle(title) {
    const excludedNamespaces = [
        'File:',
        'Category:',
        'User:',
        'Draft:',
        'Book:',
        'Template:'
    ];

    return (
        !excludedNamespaces.some(namespace => title.startsWith(namespace)) &&
        title !== 'Index of Singapore-related articles'
    );
}

/**
 * Globally spaces the start of category requests.
 *
 * Both workers use the same queue, so they cannot begin requests
 * simultaneously. The loop rechecks globalBlockedUntil because another
 * worker may impose a longer cooldown while this worker is waiting.
 */
function acquireRequestSlot() {
    const turn = limiterQueue.then(async () => {
        while (true) {
            const now = Date.now();
            const allowedAt = Math.max(
                nextRequestAt,
                globalBlockedUntil
            );
            const delay = allowedAt - now;

            if (delay <= 0) {
                nextRequestAt =
                    Date.now() +
                    REQUEST_INTERVAL_MS +
                    Math.floor(
                        Math.random() * REQUEST_JITTER_MS
                    );

                return;
            }

            await waitFor(delay);
        }
    });

    // Ensure one failed queue operation does not break later scheduling.
    limiterQueue = turn.catch(() => {});

    return turn;
}

/**
 * Pauses all workers until the cooldown expires.
 */
function applyGlobalCooldown(delay) {
    globalBlockedUntil = Math.max(
        globalBlockedUntil,
        Date.now() + delay
    );
}

async function mediaWikiApiRequest(parameters, attempt = 1) {
    await acquireRequestSlot();

    const url = new URL('https://en.wikipedia.org/w/api.php');

    const query = {
        action: 'query',
        format: 'json',
        formatversion: '2',
        maxlag: '5',
        ...parameters
    };

    Object.entries(query).forEach(([key, value]) => {
        url.searchParams.set(key, value);
    });

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT
            }
        });

        if (!response.ok) {
            const error = new Error(
                `${response.status}: ${response.statusText}`
            );

            error.status = response.status;
            error.retryAfter = response.headers.get('retry-after');

            throw error;
        }

        const data = await response.json();

        if (data.error) {
            const error = new Error(
                `${data.error.code}: ${data.error.info}`
            );

            error.code = data.error.code;
            throw error;
        }

        return data;
    } catch (error) {
        if (attempt >= MAX_ATTEMPTS) {
            throw error;
        }

        const retryAfter = Number(error.retryAfter);
        const isRateLimited = error.status === 429;
        const isMaxlag = error.code === 'maxlag';

        const baseDelay =
            Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : (isRateLimited || isMaxlag)
                    ? 30000 * (2 ** (attempt - 1))
                    : 5000 * (2 ** (attempt - 1));

        const jitter = Math.floor(Math.random() * 5000);

        const delay = Math.min(
            baseDelay + jitter,
            10 * 60 * 1000
        );

        applyGlobalCooldown(delay);

        logger.warn(
            `API helper retry ${attempt + 1}/${MAX_ATTEMPTS} ` +
            `after a global cooldown of ` +
            `${Math.ceil(delay / 1000)} seconds`
        );

        return mediaWikiApiRequest(parameters, attempt + 1);
    }
}

function categoryTitle(categoryName) {
    return `Category:${categoryName}`;
}

function categoryNameFromTitle(title) {
    return title.replace(/^Category:/, '');
}

function categoryKey(categoryName) {
    const normalised = categoryName
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalised) {
        return normalised;
    }

    // MediaWiki normalises the first character of titles.
    return (
        normalised.charAt(0).toUpperCase() +
        normalised.slice(1)
    );
}

function sameCategoryName(firstName, secondName) {
    return categoryKey(firstName) === categoryKey(secondName);
}

function deduplicateCategoryList(categoryList, changes) {
    const seen = new Set();
    const uniqueCategories = [];

    for (const categoryName of categoryList) {
        const key = categoryKey(categoryName);

        if (seen.has(key)) {
            changes.push({
                action: 'DEDUPLICATED',
                oldName: categoryName
            });

            continue;
        }

        seen.add(key);
        uniqueCategories.push(categoryName);
    }

    categoryList.splice(
        0,
        categoryList.length,
        ...uniqueCategories
    );
}

async function inspectCategories(categoryList) {
    const missingCategories = [];
    const emptyCategories = [];
    const batchSize = 50;

    for (
        let offset = 0;
        offset < categoryList.length;
        offset += batchSize
    ) {
        const batch = categoryList.slice(
            offset,
            offset + batchSize
        );

        const requestedTitles = batch.map(categoryTitle);

        const originalByTitle = new Map(
            requestedTitles.map((title, index) => [
                title,
                batch[index]
            ])
        );

        const data = await mediaWikiApiRequest({
            prop: 'info|categoryinfo',
            titles: requestedTitles.join('|')
        });

        for (const normalisation of data.query.normalized || []) {
            if (originalByTitle.has(normalisation.from)) {
                originalByTitle.set(
                    normalisation.to,
                    originalByTitle.get(normalisation.from)
                );
            }
        }

        for (const page of data.query.pages || []) {
            const categoryName =
                originalByTitle.get(page.title) ||
                categoryNameFromTitle(page.title);

            if ('missing' in page) {
                missingCategories.push(categoryName);
            } else if (
                page.categoryinfo &&
                page.categoryinfo.size === 0
            ) {
                emptyCategories.push(categoryName);
            }
        }
    }

    return {
        missingCategories,
        emptyCategories
    };
}

async function categoryExists(categoryName) {
    const data = await mediaWikiApiRequest({
        prop: 'info',
        titles: categoryTitle(categoryName)
    });

    const page = data.query.pages && data.query.pages[0];

    return Boolean(page && !('missing' in page));
}

async function findSoftRedirectTarget(
    categoryName,
    visited = new Set()
) {
    const key = categoryKey(categoryName);

    if (visited.has(key)) {
        logger.warn(
            `Circular category redirect detected at ` +
            `"${categoryName}"`
        );

        return null;
    }

    visited.add(key);

    const data = await mediaWikiApiRequest({
        action: 'expandtemplates',
        prop: 'wikitext',
        text:
            `{{Resolve category redirect|` +
            `${categoryName}}}`
    });

    const expanded =
        data.expandtemplates &&
        data.expandtemplates.wikitext;

    if (typeof expanded !== 'string') {
        return null;
    }

    const targetName = categoryNameFromTitle(
        expanded.trim()
    );

    // The resolver returns the input when it is not redirected.
    if (
        !targetName ||
        sameCategoryName(targetName, categoryName)
    ) {
        return null;
    }

    /*
     * If the soft-redirect destination was itself moved and deleted,
     * follow its move log.
     */
    if (!(await categoryExists(targetName))) {
        return findMoveTarget(targetName);
    }

    /*
     * Follow chained soft category redirects. If the target is not
     * itself redirected, return the current target.
     */
    const nextTarget = await findSoftRedirectTarget(
        targetName,
        visited
    );

    return nextTarget || targetName;
}

async function findMoveTarget(
    categoryName,
    visited = new Set()
) {
    const key = categoryKey(categoryName);

    if (visited.has(key)) {
        return null;
    }

    visited.add(key);

    const data = await mediaWikiApiRequest({
        list: 'logevents',
        letitle: categoryTitle(categoryName),
        letype: 'move',
        leprop: 'type|title|timestamp|details',
        lelimit: '10'
    });

    const events = data.query.logevents || [];

    const moveEvent = events.find(event =>
        event.params &&
        typeof event.params.target_title === 'string' &&
        event.params.target_title.startsWith('Category:')
    );

    if (!moveEvent) {
        return null;
    }

    const targetName = categoryNameFromTitle(
        moveEvent.params.target_title
    );

    if (await categoryExists(targetName)) {
        return targetName;
    }

    // Follow chained category moves.
    return findMoveTarget(targetName, visited);
}

function updateCategoryName(
    categoryList,
    oldName,
    newName,
    changes,
    action = 'MOVED'
) {
    const oldIndex = categoryList.findIndex(
        categoryName =>
            sameCategoryName(categoryName, oldName)
    );

    if (
        oldIndex === -1 ||
        sameCategoryName(oldName, newName)
    ) {
        return;
    }

    const existingTargetIndex = categoryList.findIndex(
        categoryName =>
            sameCategoryName(categoryName, newName)
    );

    if (existingTargetIndex === -1) {
        categoryList[oldIndex] = newName;
    } else {
        // The replacement already exists, so only remove the old name.
        categoryList.splice(oldIndex, 1);
    }

    changes.push({
        action,
        oldName,
        newName
    });
}

function deleteCategoryName(
    categoryList,
    categoryName,
    changes
) {
    const index = categoryList.indexOf(categoryName);

    if (index === -1) {
        return;
    }

    categoryList.splice(index, 1);

    changes.push({
        action: 'REMOVED',
        oldName: categoryName
    });
}

async function updateCategoryListFile(
    categoryList,
    newline,
    hadTrailingNewline
) {
    const changes = [];

    // Remove duplicates before making API checks.
    deduplicateCategoryList(categoryList, changes);

    const {
        missingCategories,
        emptyCategories
    } = await inspectCategories(categoryList);

    /*
     * A missing category may have been moved and subsequently
     * deleted. Consult its move log before removing it.
     */
    for (const categoryName of missingCategories) {
        const moveTarget = await findMoveTarget(categoryName);

        if (moveTarget) {
            updateCategoryName(
                categoryList,
                categoryName,
                moveTarget,
                changes,
                'MOVED'
            );
        } else {
            deleteCategoryName(
                categoryList,
                categoryName,
                changes
            );
        }
    }

    /*
     * Existing empty categories may be soft redirects using
     * {{Category redirect}}.
     */
    for (const categoryName of emptyCategories) {
        const redirectTarget =
            await findSoftRedirectTarget(categoryName);

        if (redirectTarget) {
            updateCategoryName(
                categoryList,
                categoryName,
                redirectTarget,
                changes,
                'SOFT_REDIRECT'
            );
        }
    }

    if (changes.length === 0) {
        console.log(
            `${CATEGORY_LIST_FILE} requires no changes.`
        );

        return;
    }

    const updatedContent =
        categoryList.join(newline) +
        (hadTrailingNewline ? newline : '');

    const temporaryFile = `${CATEGORY_LIST_FILE}.tmp`;

    await fs.writeFileAsync(
        temporaryFile,
        updatedContent,
        'utf8'
    );

    await fs.renameAsync(
        temporaryFile,
        CATEGORY_LIST_FILE
    );

    const timestamp = new Date().toISOString();

    const logLines = changes.map(change => {
        if (
            change.action === 'MOVED' ||
            change.action === 'SOFT_REDIRECT'
        ) {
            return (
                `${timestamp}\t${change.action}\t` +
                `${change.oldName}\t${change.newName}`
            );
        }

        return (
            `${timestamp}\t${change.action}\t` +
            `${change.oldName}`
        );
    });

    await fs.appendFileAsync(
        CATEGORY_CHANGE_LOG_FILE,
        `${logLines.join('\n')}\n`,
        'utf8'
    );

    console.log(
        `Updated ${CATEGORY_LIST_FILE}: ` +
        `${changes.length} category change(s)`
    );
}

async function fetchCategory(categoryName, attempt = 1) {
    try {
        await acquireRequestSlot();

        const pages = await wikipedia.pagesInCategory(
            `Category:${categoryName}`
        );

        return pages
            .map(normaliseTitle)
            .filter(shouldIncludeTitle);
    } catch (error) {
        const isRateLimited =
            error.message &&
            error.message.includes('429');

        logger.error('Failed to retrieve category', {
            category: categoryName,
            attempt,
            message: error.message,
            stack: error.stack
        });

        if (attempt >= MAX_ATTEMPTS) {
            throw new Error(
                `Failed to retrieve "${categoryName}" after ` +
                `${MAX_ATTEMPTS} attempts: ${error.message}`
            );
        }

        const baseDelay = isRateLimited
            ? 30000 * (2 ** (attempt - 1))
            : 5000 * (2 ** (attempt - 1));

        const jitter = Math.floor(Math.random() * 5000);
        const delay = Math.min(
            baseDelay + jitter,
            10 * 60 * 1000
        );

        /*
         * Apply the delay globally. Both workers will wait before
         * starting another category request.
         */
        applyGlobalCooldown(delay);

        logger.warn(
            `Retrying "${categoryName}" after a global cooldown of ` +
            `${Math.ceil(delay / 1000)} seconds`
        );

        return fetchCategory(categoryName, attempt + 1);
    }
}

async function main() {
    await fs.mkdirAsync('logs', {
        recursive: true
    });

    const content = await fs.readFileAsync(
        CATEGORY_LIST_FILE,
        'utf8'
    );

    const newline = content.includes('\r\n')
        ? '\r\n'
        : '\n';

    const hadTrailingNewline = /\r?\n$/.test(content);

    const categoryList = content
        .split(/\r?\n/)
        .map(category => category.trim())
        .filter(Boolean);

    console.log(
        `Checking ${CATEGORY_LIST_FILE} for ` +
        'redirected, moved, removed or duplicate categories...'
    );

    await updateCategoryListFile(
        categoryList,
        newline,
        hadTrailingNewline
    );

    console.log("Knocking on Wikipedia's door...");
    progress.start(categoryList.length, 0);

    await Promise.map(
        categoryList,
        async categoryName => {
            const pages = await fetchCategory(categoryName);
            outputArray.push(...pages);
            progress.increment();
        },
        {
            concurrency: 2
        }
    );

    progress.stop();

    const sortedTitles = _.sortBy(_.uniq(outputArray));

    console.log(`Total number of articles: ${sortedTitles.length}`);
    console.log('Writing to file...');
    const outputFile = require('fs').createWriteStream('pages3.txt', {
        flags: 'w'
    });

    outputFile.write('{{short description|none}}\n');
    outputFile.write('{{use British English|date=August 2019}}\n');
    outputFile.write('{{use dmy dates|date=August 2019}}\n');
    outputFile.write(
        '<noinclude>{{shortcut|WP:SGINDEX|WP:SG/INDEX}}</noinclude>\n'
    );
    outputFile.write(
        "This is a '''list of [[Singapore]]-related articles by " +
        "alphabetical order'''. To learn quickly what Singapore is, see " +
        '[[Outline of Singapore]]. Those interested in the subject can ' +
        "monitor changes to the pages by clicking on ''Related changes'' " +
        'in the sidebar. A list of [[to do]] topics can be found ' +
        '[[Wikipedia:WikiProject Singapore/Article improvement|here]].\n'
    );
    outputFile.write(
        '{{alphanumeric TOC|numbers=yes|align=center}}\n\n'
    );

    let currentHeading = null;

    for (const title of sortedTitles) {
        const firstCharacter = title.charAt(0).toUpperCase();
        const heading = /^[A-Z]$/.test(firstCharacter)
            ? firstCharacter
            : '0-9';

        if (heading !== currentHeading) {
            if (currentHeading !== null) {
                outputFile.write('{{div col end}}\n');
                outputFile.write(
                    '{{alphanumeric TOC|numbers=yes|align=center|top=yes}}\n'
                );
            }

            outputFile.write(`\n==${heading}==\n`);
            outputFile.write('{{div col|colwidth=25em}}\n');
            currentHeading = heading;
        }

        outputFile.write(`* [[${title}]]\n`);
    }

    if (currentHeading !== null) {
        outputFile.write('{{div col end}}\n');
    }

    outputFile.write('==See also==\n\n');
    outputFile.write('* [[Outline of Singapore]]\n');
    outputFile.write(
        '* [[Lists of country-related topics]] – ' +
        'similar lists for other countries\n'
    );
    outputFile.write('{{portal bar|Singapore|Cities|Islands|Asia}}\n');
    outputFile.write('{{Index footer}}\n\n');
    outputFile.write(
        '{{DEFAULTSORT:Index Of Singapore-related Articles}}\n'
    );

    await new Promise((resolve, reject) => {
        outputFile.end(error => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });

    console.log('Write complete.');
    console.log('Ready for verification and upload.');
}

main().catch(error => {
    progress.stop();
    logger.error('Fatal error', {
        message: error.message,
        stack: error.stack
    });
    process.exitCode = 1;
});