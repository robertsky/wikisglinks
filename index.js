const _ = require('lodash');
const _colors = require('colors');
const cliProgress = require('cli-progress');
const Promise = require('bluebird');
const wiki = require('wikijs').default;
const waitFor = (ms) => new Promise(r => setTimeout(r, ms))
const writeFile = require('fs').createWriteStream("pages3.txt", {flags:'w'});
var outputArray = [];
var headings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const b1 = new cliProgress.SingleBar({
    format: 'Categories accessed |' + _colors.cyan('{bar}') + '| {percentage}% || {value}/{total} categories',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
});

let fs = Promise.promisifyAll(require('fs'));

fs.readFileAsync('category-list.txt', 'utf8').then(function(content) {
    let catList = content.split('\r\n');
    console.log('Knocking on Wikipedia\'s door...');
    b1.start(catList.length, 0);
    return catList;
}).map(async function(catList) {
    if (!!catList && catList.length > 0) {
        await waitFor(3000);
        wiki({
            apiUrl: 'https://en.wikipedia.org/w/api.php',
            headers: { 'User-Agent': 'WikiSgLinksBot/0.1 (https://github.com/robertsky/wikisglinks) wikijs/6.0.1' }
        }).pagesInCategory('Category:' + catList).then(function(result) {
            var filteredResult = result.filter(title => (!title.startsWith('File:') && !title.startsWith('Category:') && !title.startsWith('User:') && !title.startsWith('Draft:')));
            filteredResult.forEach(function(val,idx) {
                this[idx] = val.replace(/^Talk\:/, '');
                this[idx] = val.replace(/^Book talk\:/,'Book:');
                switch(val) {
                    case 'Singapore Armed Forces Training Institute':
                    case 'Judge of Singapore':
                        this[idx] = val +' (disambiguation)';
                }
            }, filteredResult);
            return filteredResult;
        }).then(function(result) {
            if (!!result.length) {
                outputArray = _.union(outputArray, result);
            }
            b1.increment();
            return 'write';
        }).catch((error) => console.error(error));
    }
}, {concurrency: 100}).delay(3000).then(function(){
    b1.stop();
    console.log('Total number of articles: ' + outputArray.length);
    console.log('Sorting...');
    outputArray = _.sortBy(_.uniq(outputArray), [function(o) {return o;}]);
    console.log('Writing to file...');
    writeFile.write("{{use Singapore English|date=August 2019}}\n");
    writeFile.write("{{use dmy dates|date=August 2019}}\n");
    writeFile.write("{{short description|Wikimedia list article}}\n");
    writeFile.write("This is a '''list of [[Singapore]]-related articles by alphabetical order'''. For a list by topic, see [[list of Singapore-related topics]]. Those interested in the subject can monitor changes to the pages by clicking on ''Related changes'' in the sidebar. A list of [[to do]] topics can be found [[Wikipedia:WikiProject_Singapore/Article_improvement|here]].\n\n");
    writeFile.write("Articles related to '''[[Singapore]]''' include:\n");
    writeFile.write('{{alphanumeric TOC|numbers=yes|align=center}}\n');
    writeFile.write('==0-9==\n')
    writeFile.write('{{div col|colwidth=25em}}\n');
    var headingPosition = 0;
    outputArray.forEach((title) => {
        const firstChar = title.charAt(0);
        if (firstChar === headings.charAt(headingPosition)) {
            writeFile.write('{{div col end}}\n');
            writeFile.write('{{alphanumeric TOC|numbers=yes|align=center|top=yes}}\n');
            writeFile.write('==' + headings.charAt(headingPosition) + '==\n');
            writeFile.write('{{div col|colwidth=25em}}\n');
            headingPosition++;
        }
        writeFile.write('* [[' + title + ']]\n');
    })
    writeFile.write('{{div col end}}\n');
    writeFile.write("==See also==\n");
    writeFile.write("*[[List of Singapore-related topics]]\n");
    writeFile.write("*[[Lists of country-related topics]] - similar lists for other countries\n\n");
    writeFile.write("{{Index footer}}\n\n");
    writeFile.write("{{DEFAULTSORT:Index Of Singapore-Related Articles}}\n");
    writeFile.write("[[Category:Singapore-related lists]]\n");
    writeFile.write("[[Category:Indexes of topics by country|Singapore]]");
    console.log('Write complete...');
    console.log('Ready for verification and upload.');
}).catch((error) => console.error(error));