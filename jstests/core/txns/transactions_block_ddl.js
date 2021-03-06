// Test that open transactions block DDL operations on the involved collections.
// @tags: [uses_transactions]
(function() {
    "use strict";

    load("jstests/libs/parallelTester.js");  // for ScopedThread.

    const collName = "transactions_block_ddl";
    const testDB = db.getSiblingDB("test");

    const session = testDB.getMongo().startSession({causalConsistency: false});
    const sessionDB = session.getDatabase("test");
    const sessionColl = sessionDB[collName];

    /**
     * Tests that DDL operations block on transactions and fail when their maxTimeMS expires.
     */
    function testTimeout(dbName, ddlCmd) {
        // Setup.
        sessionDB.runCommand({drop: collName, writeConcern: {w: "majority"}});
        assert.commandWorked(sessionColl.createIndex({b: 1}, {name: "b_1"}));

        session.startTransaction();
        assert.commandWorked(sessionColl.insert({a: 5, b: 6}));
        assert.commandFailedWithCode(
            testDB.getSiblingDB(dbName).runCommand(Object.assign({}, ddlCmd, {maxTimeMS: 500})),
            ErrorCodes.ExceededTimeLimit);
        assert.commandWorked(session.commitTransaction_forTesting());
    }

    /**
     * Tests that DDL operations block on transactions but can succeed once the transaction commits.
     */
    function testSuccessOnTxnCommit(dbName, ddlCmd, currentOpFilter) {
        // Setup.
        sessionDB.runCommand({drop: collName, writeConcern: {w: "majority"}});
        assert.commandWorked(sessionColl.createIndex({b: 1}, {name: "b_1"}));

        session.startTransaction();
        assert.commandWorked(sessionColl.insert({a: 5, b: 6}));
        let thread = new ScopedThread(function(testData, dbName, ddlCmd) {
            TestData = testData;
            return db.getSiblingDB(dbName).runCommand(ddlCmd);
        }, TestData, dbName, ddlCmd);
        thread.start();
        // Wait for the DDL operation to have pending locks.
        assert.soon(
            function() {
                // Note that we cannot use the $currentOp agg stage because it acquires locks
                // (SERVER-35289).
                return testDB.currentOp({$and: [currentOpFilter, {waitingForLock: true}]})
                           .inprog.length === 1;
            },
            function() {
                return "Failed to find DDL command in currentOp output: " +
                    tojson(testDB.currentOp().inprog);
            });
        assert.commandWorked(session.commitTransaction_forTesting());
        thread.join();
        assert.commandWorked(thread.returnData());
    }

    // Test 'drop'.
    const dropCmd = {drop: collName, writeConcern: {w: "majority"}};
    testTimeout("test", dropCmd);
    testSuccessOnTxnCommit("test", dropCmd, {"command.drop": collName});

    // Test 'dropDatabase'.
    // We cannot run testTimeout() for dropDatabase, since dropDatabase does not respect maxTimeMS
    // TODO SERVER-35290: Run testTimeout() for dropDatabase.
    const dropDatabaseCmd = {dropDatabase: 1, writeConcern: {w: "majority"}};
    testSuccessOnTxnCommit("test", dropDatabaseCmd, {"command.dropDatabase": 1});

    // Test 'renameCollection' in the same database.
    testDB.runCommand({drop: "otherColl", writeConcern: {w: "majority"}});
    const renameCollectionCmdSameDB = {
        renameCollection: sessionColl.getFullName(),
        to: "test.otherColl",
        writeConcern: {w: "majority"}
    };
    testTimeout("admin", renameCollectionCmdSameDB);
    testSuccessOnTxnCommit("admin",
                           renameCollectionCmdSameDB,
                           {"command.renameCollection": sessionColl.getFullName()});

    // Test 'renameCollection' across databases.
    testDB.getSiblingDB("otherDB").runCommand({drop: "otherColl", writeConcern: {w: "majority"}});
    const renameCollectionCmdDifferentDB = {
        renameCollection: sessionColl.getFullName(),
        to: "otherDB.otherColl",
        writeConcern: {w: "majority"}
    };
    testTimeout("admin", renameCollectionCmdDifferentDB);
    testSuccessOnTxnCommit("admin",
                           renameCollectionCmdDifferentDB,
                           {"command.renameCollection": sessionColl.getFullName()});

    // Test 'createIndexes'. The transaction will insert a document that has a field 'a'.
    const createIndexesCmd = {
        createIndexes: collName,
        indexes: [{key: {a: 1}, name: "a_1"}],
        writeConcern: {w: "majority"}
    };
    testTimeout("test", createIndexesCmd);
    testSuccessOnTxnCommit("test", createIndexesCmd, {"command.createIndexes": collName});

    // Test 'dropIndexes'. The setup creates an index on {b: 1} called 'b_1'. The transaction will
    // insert a document that has a field 'b'.
    const dropIndexesCmd = {dropIndexes: collName, index: "b_1", writeConcern: {w: "majority"}};
    testTimeout("test", dropIndexesCmd);
    testSuccessOnTxnCommit("test", dropIndexesCmd, {"command.dropIndexes": collName});
    session.endSession();
}());
