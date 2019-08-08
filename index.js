const _ = require('lodash');
const Promise = require('bluebird');
const wiki = require('wikijs').default;
const waitFor = (ms) => new Promise(r => setTimeout(r, ms))
const writeFile = require('fs').createWriteStream("pages3.txt", {flags:'a'});
var outputArray = [];
var headings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

Promise.map(require('fs').readFileSync('category-list.txt', 'utf8').split('\r\n'), async(cat) => {
    if (!!cat && cat.length > 0) {
        await waitFor(3000)
        wiki({
            apiUrl: 'https://en.wikipedia.org/w/api.php'
        }).pagesInCategory('Category:' + cat).then(function(result) {
            var filteredResult = result.filter(title => (!title.startsWith('File:') && !title.startsWith('Category:') && !title.startsWith('Template:') && !title.startsWith('User:')));
            console.log(cat +' length: ' + filteredResult.length);
            return filteredResult;
        }).then(function(result) {
            if (!!result.length) {
                outputArray = _.union(outputArray, result);
            }
            return 'write';
        });
    }
}, {concurrency: 100}).delay(5000).then(function(){
    outputArray = _.sortBy(_.uniq(outputArray), [function(o) {return o;}]);
    writeFile.write('{{alphanumeric TOC|numbers=yes|align=center}}\n');
    writeFile.write('==0-9==\n')
    writeFile.write('{{div col|colwidth=25em}}\n');
    var headingPosition = 0;
    outputArray.forEach((title) => {
        const firstChar = title.charAt(0);
        if (firstChar === headings.charAt(headingPosition)) {
            writeFile.write('{{div col end}}\n\n');
            writeFile.write('{{alphanumeric TOC|numbers=yes|align=center|top=yes}}\n');
            writeFile.write('==' + headings.charAt(headingPosition) + '==\n');
            writeFile.write('{{div col|colwidth=25em}}\n');
            headingPosition++;
        }
        writeFile.write('* [[' + title + ']]\n');
    })
    writeFile.write('{{div col end}}\n');
});
