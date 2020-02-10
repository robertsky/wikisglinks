const _ = require('lodash');
const Promise = require('bluebird');
const wiki = require('wikijs').default;
const waitFor = (ms) => new Promise(r => setTimeout(r, ms))
const writeFile = require('fs').createWriteStream("pages3.txt", {flags:'w'});
var outputArray = [];
var headings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

Promise.map(require('fs').readFileSync('category-list.txt', 'utf8').split('\r\n'), async(cat) => {
    if (!!cat && cat.length > 0) {
        await waitFor(3000)
        wiki({
            apiUrl: 'https://en.wikipedia.org/w/api.php',
            headers: { 'User-Agent': 'WikiSgLinksBot/0.1 (https://github.com/robertsky/wikisglinks) wikijs/6.0.1' }
        }).pagesInCategory('Category:' + cat).then(function(result) {
            var filteredResult = result.filter(title => (!title.startsWith('File:') && !title.startsWith('Category:') && !title.startsWith('User:') && !title.startsWith('Draft:')));
            console.log(cat +' length: ' + filteredResult.length);
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
            return 'write';
        });
    }
}, {concurrency: 200}).delay(5000).then(function(){
    outputArray = _.sortBy(_.uniq(outputArray), [function(o) {return o;}]);
    writeFile.write("{{use Singapore English|date=August 2019}}\n");
    writeFile.write("{{use dmy dates|date=August 2019}}\n");
    writeFile.write("{{short description|Wikimedia list article}}\n");
    writeFile.write("This is a '''list of [[Singapore]]-related articles by alphabetical order'''. For a list by topic, see [[list of Singapore-related topics]]. Those interested in the subject can monitor changes to the pages by clicking on ''Related changes'' in the sidebar. A list of [[to do]] topics can be found [[Wikipedia:SGpedians' notice board/complete to do|here]].\n\n");
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
});
