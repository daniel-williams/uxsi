const fs = require('fs');
const { sessionTargets } = require('./session-targets.rs3.js');
const studyFormat = require('./studyFormat').studyFormat;
const eolCheckOrder = [
  { name: 'carriage return + new line', token: /\r\n/g },
  { name: 'new line', token: /\n/g },
  { name: 'carriage return', token: /\r/g },
  // { name: 'tab', token: /\t/g },
];
const responseMap = studyFormat.responseMap;
const DATA_ROOT = sessionTargets.dataRoot;
const verboseTest = /verbose/i;
const VERBOSE = process.argv.some(item => verboseTest.test(item));

let study = studyFormat.studies.find(x => x.id === sessionTargets.studyId);
let studyHashMap = {};

sessionTargets.dataFiles.forEach(item => {
  let group = !!item.group
    ? study.groups.find(x => x.title === item.group)
    : null;

  // process each referenced file
  item.fileList.forEach(file => {
    console.log(`\r\nImporting file '${file}' ${item.browser ? ("as " + item.browser + ":") : "as questionaire"}${item.group || "" }`);
    let rows = importFileAsRows(file);
    let fileHashMap = generateDataMap(rows, item.targets, item.key, group, file);

    Object.keys(fileHashMap).filter(target => {
      return target != undefined;
    }).forEach(target => {
      if (!studyHashMap[target]) {
        studyHashMap[target] = {};
      }

      if (!!item.browser) {
        studyHashMap[target]['__browser'] = item.browser;
        studyHashMap[target]['__session'] = item.session;
        studyHashMap[target]['__timestamp'] = item.timestamp;
      }

      if (item.group !== null) {
        studyHashMap[target]['__taskGroup'] = item.group;
        studyHashMap[target].__tasks = fileHashMap[target];
      } else {
        studyHashMap[target] = Object.assign({}, studyHashMap[target], fileHashMap[target]);
      }
    });
  });
});

let checkResult = checkImportResults(studyHashMap, study);

if(checkResult) {
  exportAsFile('export.json', studyHashMap);
}

function importFileAsRows(filename) {
  let fileRows = [];
  let resultRows = [];

  try {
    let fileData = fs.readFileSync(DATA_ROOT + filename, 'utf8');
    let eol;
    let eolInstances = -1;

    // find file eol
    eolCheckOrder.find((eolCheck, index) => {
      let result = fileData.match(eolCheck.token);
      let count = (result || []).length;

      if (count) {
        eol = eolCheck;
        eolInstances = count;

        if(VERBOSE) {
          console.log(`Set eol to '${eolCheck.name}' ${count} instances found.`);
        }

        return true;
      };
    });

    // transform file to rows
    fileRows = fileData.split(eol.token);


    // * Maybe a check at the last fileData char would allow a more precise outcome
    if (fileRows.length !== eolInstances && fileRows.length !== (eolInstances + 1)) {
      console.log('Expected fileRows length ' + fileRows.length + ' to equal eolInstances ' + eolInstances);
    }
    // console.log('Row count is ' + fileRows.length);
    // console.log('\r\n', '** Processing rows');

    fileRows.forEach((row, index) => {
      let rowNumber = index + 1; // only used for logging
      // early studies had mixed eol characters (format seems to be getting better)
      let hasExpandedRows = eolCheckOrder.find(eolCheck => {
        let count = (row.match(eolCheck.token) || []).length;

        if (count) {
          let expandedRows = row.split(eolCheck.token);

          console.log('@row ' + rowNumber + ': Expanding (' + expandedRows.length + ')');
          expandedRows.forEach((x, i) => {
            resultRows.push(x);
            console.log(`  +row ${rowNumber}.${i + 1} - (${resultRows.length})`);
          });
        }

        return !!count;
      });

      if (!hasExpandedRows) {
        resultRows.push(row);

        if(VERBOSE) {
          console.log(`+row ${rowNumber} = (${resultRows.length})`);
        }
      }

    });

  } catch (err) {
    console.log('error loading data: ', err);
  }

  return resultRows;
}

function generateDataMap(rows, props, key, group, file) {
  let dataMap = {};
  let participantList = [];
  let keyIndex = 0;
  let hasWordMatchSteps = false;
  let nonWordMatchList = [];

  // find keyIndex based
  rows.find((row, index) => {
    let tokens = row.split('\t');

    if (tokens.length && tokens[0] === key) {
      keyIndex = index;
      return true;
    }
    return false;
  });

  // once we find keyIndex, we can cache participant keys
  if (keyIndex < 0) {
    console.log(`key prop "${key}" not found`);
  } else {
    let surveyIds = rows[keyIndex].split('\t').slice(1); // strips first column!

    for (var i = 0; i < surveyIds.length; i++) {
      let surveyId = surveyIds[i];

      participantList.push(surveyId);
      // dataMap[surveyId] = {};
    }
  }

  rows.forEach((row, index) => {
    let rowTokens = row.split('\t'); // tabs

    if (rowTokens.length) {
      /*
       * first column of rowData is expected to contain the property name, which
       * for that row, describes the data contained in subsequent columns
       */
      let propName = rowTokens[0];

      if (props && props[propName] != undefined) {
        let studyStep = getStudyStep(group, propName);
        let lineOffset = props[propName];
        let targetRow = rows[index + lineOffset];
        let rowCells = targetRow
          .split('\t')
          .slice(1); // strip propName column

        for (var i = 0; i < rowCells.length; i++) {
          let cellVal = scrubResponse(rowCells[i]);

          if (cellVal.indexOf(':::') >= 0) {
            let linkParts = cellVal.split(':::');

            if (linkParts.length === 2) {
              let duration = getClipDuration(linkParts[0]);
              let offset = getClipOffset(linkParts[1]);

              if (duration != undefined && offset != undefined) {
                cellVal = {
                  offset,
                  duration
                };
              } else {
                cellVal = linkParts[0];
              }
            }
          }

          // debug cellVal
          if (studyStep) {
            if (studyStep.responseType === 'yesNoMaybe') {
              cellVal = responseMap.yesNoMaybe.byResponse[cellVal];
            } else if (studyStep.responseType === 'timeOnTask') {
              cellVal = responseMap.timeOnTask.byResponse[cellVal];
            } else if (studyStep.responseType === 'satisfactionScale') {
              cellVal = responseMap.satisfactionScale.byResponse[cellVal];
            } else if (studyStep.responseType === 'agreementScale') {
              let n = parseInt(cellVal);

              cellVal = isNaN(n) ? cellVal : n;
            } else if (studyStep.responseType === 'wordAssociation') {
              hasWordMatchSteps = true;
              let matchWords = responseMap.wordAssociation.responses.reduce((accum, item) => {
                let reg = new RegExp(('\\b' + item), "gi");
                let count = (cellVal.match(reg) || []).length;

                if (count) {
                  accum[item] = count;
                }

                return accum;
              }, {});

              let matched = '';
              Object.keys(matchWords).forEach(x => {
                if (matchWords[x] > 0) {
                  matched = matched + ' ' + x + ':' + matchWords[x];
                }
              });

              if(!matched) {
                // Should be catching misspelled words during scrub step. Logging to console for peace of mind.
                nonWordMatchList.push('No words matched in response "' + cellVal + '" @ ' + participantList[i] + ' | ' + studyStep.id);
              } else if(VERBOSE) {
                nonWordMatchList.push('Words matched: "' + cellVal + '" == ' + matched + ' @ ' + participantList[i] + ' | ' + studyStep.id);
              }
              cellVal = matchWords;
            }
          }

          if (group) {
            let taskIndex = propName.slice(5);

            if (!dataMap[participantList[i]]) {
              dataMap[participantList[i]] = [];
            }

            dataMap[participantList[i]][taskIndex] = cellVal;
          } else {
            if (!dataMap[participantList[i]]) {
              dataMap[participantList[i]] = {};
            }

            dataMap[participantList[i]][propName] = cellVal;
          }

        }
      }
    }
  });

  if(hasWordMatchSteps) {
    console.log('Checking word associations');
    if(nonWordMatchList.length === 0 && !VERBOSE) {
      console.log('All responses contained matches');
    } else {
      nonWordMatchList.forEach(x => console.log(x));
    }
  }

  return dataMap;
}

function getStudyStep(group, propName) {
  if (group && group.tasks) {
    return group.tasks.find(task => task.id === propName);
  }
}

function scrubResponse(response) {
  return response.replace(/\"/g, '');
}

function getClipOffset(url) {
  let offset = undefined;

  if (url.indexOf('http') === 0 && url.indexOf('start=') >= 0) {
    let startVal = parseInt(url.split('start=')[1]);

    if (!isNaN(startVal)) {
      offset = startVal;
    }
  }

  return offset;
}

function getClipDuration(timecode) {
  let duration = undefined;

  if (timecode.indexOf(':') === 2) {
    let timecodeParts = timecode.split(':');
    let minutes = parseInt(timecodeParts[0]);
    let seconds = parseInt(timecodeParts[1]);

    if (!isNaN(minutes) && !isNaN(seconds)) {
      duration = (minutes * 60) + seconds;
    }
  }

  return duration;
}

function checkImportResults(studyHashMap, study) {
  let result = true;

  console.log('\r\nConfirming participant data');

  Object.keys(studyHashMap).sort().forEach((id, index) => {
    let group = studyHashMap[id].__taskGroup;
    let tasks = studyHashMap[id].__tasks;
    let missingTasks = [];
    let taskCount = study.groups.find(x => x.title === group).tasks.length;

    for(var i = 1; i <= taskCount; i++) {
      if(tasks[i] == undefined) {
        missingTasks.push(i)
        result = false;
      }
    }

    let result = missingTasks.length
      ? (' -> checked:missing[' + missingTasks.join(',') + ']')
      : ' -> checked:ok';

    console.log((index + 1) + ') ' + id + ' (' + group + ')' + result);
  });

  return result;
}

function exportAsFile(filename, data) {
  fs.writeFile(DATA_ROOT + filename, JSON.stringify(studyHashMap), 'utf8', function (err) {
    if (err) {
      return console.log(err);
    }

    console.log(`\r\nExport successful.`);
  });
}