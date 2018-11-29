'use strict';

const cmd = require('node-cmd');

const dbConnect = require('../../models/dbConnect');
const logging = require('../../helpers/logging/logging');
const globals = require('../../middlewares/globalVariables');

const DetectionCategory = {
    MISSED_DETECTION: 'missed',
    FALSE_POSITIVE: 'falsePositive',
    TRUE_POSITIVE: 'truePositive',
    MANUAL_DETECTION: 'manual'
};

const DetectionType = {
    VISUAL: 'visual-detection',
    AUDIO: 'audio-detection'
};

function detectionQueryCall(detectionType, victimId, detectionCategory, callback) {
    const trueResponse = detectionCategory === DetectionCategory.MISSED_DETECTION
                        || detectionCategory === DetectionCategory.FALSE_POSITIVE ? 0 : 1;

    dbConnect.pool.getConnection((error, connection) => {
        if (error) {
            callback(error, null, null);
            return;
        }

        if (detectionCategory === DetectionCategory.MISSED_DETECTION
            || detectionCategory === DetectionCategory.MANUAL_DETECTION) {
            callback(null, -1, connection);
            return;
        }

        const data = [globals.getParticipantId(), globals.getMissionId(), detectionType, trueResponse, victimId];
        connection.query(dbConnect.INSERT_QUERY, data, (error, result) => {
            if (error) {
                connection.release();
                callback(error, null, null);
                return;
            }

            callback(null, result.insertId, connection);
        });
    });
}

module.exports = function (io) {
    io.on('connection', (socket) => {
        socket.on('detection-insert-query', (data) => {
            if (!globals.isMissionRunning()) return;

            data = JSON.parse(data);

            const detectionType = data.detection.type;
            if (detectionType === undefined) {
                logging.socketOutputError(socket, 'Detection Insert Query - type not defined');
                logging.socketOutputError(socket, data);
                return;
            }

            const detectionCategory = data.detection.category;
            if (detectionCategory === undefined) {
                logging.socketOutputError(socket, 'Detection Insert Query - detection category not defined');
                logging.socketOutputError(socket, data);
                return;
            }

            if (detectionCategory !== DetectionCategory.MISSED_DETECTION
                && detectionCategory !== DetectionCategory.FALSE_POSITIVE
                && detectionCategory !== DetectionCategory.TRUE_POSITIVE
                && detectionCategory !== DetectionCategory.MANUAL_DETECTION) {
                logging.socketOutputError(socket, 'Detection Insert Query - invalid detection category');
                logging.socketOutputError(socket, data);
                return;
            }

            let filePath = data.detection.data.filePath;
            const confidence = data.detection.data.confidence;
            const robotId = data.detection.data.robotId;
            const victimId = data.detection.data.victimId;
            if (confidence === undefined
                || filePath ===undefined
                || robotId === undefined
                || victimId === undefined) {
                logging.socketOutputError(socket, 'Detection Insert Query - data missing or not defined');
                logging.socketOutputError(socket, data);
                return;
            }

            if (detectionType !== DetectionType.VISUAL && detectionType !== DetectionType.AUDIO) {
                logging.socketOutputError(socket, 'Detection Insert Query - invalid detection type (accepted values are "visual-detection" and "audio-detection"');
                logging.socketOutputError(socket, data);
                return;
            }

            if (detectionType === DetectionType.AUDIO) {
                let splitFilePath = filePath.split('.');
                splitFilePath[1] = 'ogg';
                filePath = splitFilePath.join('.');
                cmd.run('dir2ogg ~/visual-detection-images');
            }

            if (detectionCategory !== DetectionCategory.MISSED_DETECTION
                && detectionCategory !== DetectionCategory.MANUAL_DETECTION) {
                io.emit('cmtogglemanualcontrol', JSON.stringify({
                    'action': 'stop',
                    'robot_id': robotId
                }));
            }

            const toggleRobotIfSqlFails = function () {
                if (detectionCategory !== DetectionCategory.MISSED_DETECTION
                    && detectionCategory !== DetectionCategory.MANUAL_DETECTION) {
                    io.emit('cmtogglemanualcontrol', JSON.stringify({
                        'action': 'start',
                        'robot_id': robotId
                    }));
                }
            };

            detectionQueryCall(detectionType, victimId, detectionCategory, (error, queryId, connection) => {
                if (error) {
                    logging.socketOutputError(socket, error);
                    toggleRobotIfSqlFails();
                    return;
                }

                if (detectionCategory === DetectionCategory.MANUAL_DETECTION) {
                    console.log('Query: Manual detection for human id ' + victimId);

                    connection.query(dbConnect.UPDATE_MISSED_DETECTION, [globals.getParticipantId(), globals.getMissionId(), victimId], (error, result) => {
                        connection.release();

                        if (error) {
                            logging.socketOutputError(socket, error);
                        }
                    });

                    return;
                }

                const queryData = {
                    'type': detectionType,
                    'data': {
                        'query_id': queryId,
                        'robot_id': robotId,
                        'confidence': confidence,
                        'file_path': filePath
                    }
                };
                console.log('Query: ', queryData);

                const data = [
                    queryId,
                    robotId,
                    confidence,
                    filePath,
                    detectionType,
                    victimId,
                    globals.getParticipantId(),
                    globals.getMissionId(),
                    detectionCategory
                ];
                connection.query(dbConnect.INSERT_DETECTION, data, (error, result) => {
                    if (error) {
                        connection.release();
                        logging.socketOutputError(socket, error);
                        toggleRobotIfSqlFails();
                        return;
                    }

                    if (detectionCategory === DetectionCategory.MISSED_DETECTION) {
                        connection.release();
                        console.log('^Query: missed detection id' + victimId);
                        return;
                    }

                    connection.query(dbConnect.RETRIEVE_QUERY_DETECTION, [queryId], (error, result) => {
                        if (error) {
                            connection.release();
                            logging.socketOutputError(socket, error);
                            toggleRobotIfSqlFails();
                            return;
                        }

                        if (result.length < 1) {
                            connection.release();
                            logging.socketOutputError(socket, 'Detection Insert Query - no result.');
                            toggleRobotIfSqlFails();
                            return;
                        }

                        let irisData = {query: result};

                        connection.query(dbConnect.RETRIEVE_PARTICIPANT_QUERIES, [result[0].user_id], (error, result) => {
                            connection.release();

                            if (error) {
                                logging.socketOutputError(socket, error);
                                toggleRobotIfSqlFails();
                                return;
                            }

                            if (result.length < 1) {
                                logging.socketOutputError(socket, 'Detection Insert Query - no result');
                                toggleRobotIfSqlFails();
                                return;
                            }

                            irisData.participant_queries = result;

                            io.emit('irisevaluatequery', irisData);
                        });
                    });
                });
            });
        });
    });
};
